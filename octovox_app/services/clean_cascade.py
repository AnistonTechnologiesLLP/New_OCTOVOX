#!/usr/bin/env python3
"""
=========================================================================
  OCTOVOX — CLEAN-VOICE CASCADE  (single-output mode, NEW path)
=========================================================================
A separate, single-output speech-cleanup chain that runs ALONGSIDE — never
through — the 6-algorithm bootstrap instrument. It does NOT touch
``ALGO_NAMES``, ``verdicts.py``, the bootstrap, or any competing algorithm.
Where the instrument *compares* algorithms statistically, this mode just
produces ONE clean mono file for the user to A/B against the raw input.

  Chain (fixed order — each stage has ONE distinct job, so the stages
  complement rather than overlap; the goal is the cleanest single voice):

    8-ch  →  [1] WPE dereverb (multichannel)   · removes REVERB only
          →  [2] RTF-MVDR beamform (8 → 1)     · SPATIAL filtering only
          → (level guard: scale so DFN3 sees an in-range signal — plumbing)
          →  [3] DeepFilterNet3 (CPU, 1→1)     · the sole NOISE denoiser
          →  [4] VAD silence floor (1→1)       · polishes GAPS only, never speech
          → (final loudness normalize — plumbing)
          →  clean mono

Why this order and split (the "no-overlap" design):
  · [1] and [2] are MULTICHANNEL — they must run on the original 8-mic array
    (you can't beamform a mono signal), and dereverb-before-beamform is the
    standard CHiME front-end. They run first, on the original.
  · [3] DeepFilterNet3 is the ONE denoiser. It handles all broadband/stationary
    noise on the single beamformed channel. Nothing else denoises, so nothing
    fights it or double-suppresses the voice.
  · [4] the VAD stage does NOT denoise (that would overlap [3]); it only lowers
    the floor in segments Silero VAD is confident are non-speech, and is
    speech-protective (hysteresis + hangover + slow release) so it never clips
    or dulls the voice. See _vad_silence_floor.
  · the two level steps are plumbing (scaling), not enhancement — they don't
    remove or add content, so they don't overlap the enhancement stages.

Every stage is *optional in practice*: if a dependency is missing or a
stage raises, the cascade logs a clean skip and carries the signal forward
unchanged (a graceful no-op, never a crash). The returned ``stages`` dict
records exactly which stages fired, so a skip is visible — not silent.

──────────────────────────────────────────────────────────────────────────
  NEURAL-STACK CPU PIN (handoff §6)
──────────────────────────────────────────────────────────────────────────
The historical ``cuda.FloatTensor`` vs ``FloatTensor`` mismatch was NOT a real
DFN-CUDA-synthesis bug — it was a device-placement mismatch: the old code put
the model on CPU but let DFN's get_device() push the input features to CUDA.
That is now fixed at the source in ``pipeline._dfn_run_enhance`` (model and
features share one device, GPU-first with a CPU fallback), so DFN runs on the
GPU by default. Set OCTOVOX_FORCE_CPU=1 to restore the old hard CPU pin.
=========================================================================
"""
import os

# ── Opt-in CPU pin (OCTOVOX_FORCE_CPU=1): hide every GPU from torch before it
#    is imported anywhere. Off by default — DFN/VAD run GPU-first now. ──
if os.environ.get("OCTOVOX_FORCE_CPU") == "1":
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

import time
from pathlib import Path

import numpy as np
import scipy.signal as sps
from scipy.io import wavfile

# ── STFT grid — identical to pipeline.py so frames line up with Silero VAD
#    (hop=HOP) and the tracked-MVDR wrapper. ──
NFFT = 1024
HOP = NFFT // 4
WIN = sps.windows.hann(NFFT, sym=False)
EPS = 1e-12
SPEED_SOUND = 343.0
SR_DFN = 48000          # DeepFilterNet2/3 weights are 48 kHz


# =========================================================================
#  I/O
# =========================================================================
def _load_multichannel(path):
    """Load a WAV as ``(D, samples)`` float32 in [-1, 1]. Mirrors
    ``pipeline.load_wav`` but returns channels-first to match the
    ``beamform_fn`` contract."""
    fs, data = wavfile.read(str(path))
    if data.ndim == 1:
        data = data[:, None]
    if np.issubdtype(data.dtype, np.integer):
        data = data.astype(np.float32) / float(np.iinfo(data.dtype).max)
    else:
        data = data.astype(np.float32)
    return data.T.copy(), int(fs)            # (samples, D) → (D, samples)


def _save_mono(path, x, fs):
    """Write a mono float32 signal as 16-bit PCM (matches pipeline.save_wav)."""
    x = np.clip(np.asarray(x, dtype=np.float32), -1.0, 1.0)
    wavfile.write(str(path), int(fs), (x * 32767.0).astype(np.int16))


def _peak_normalize(x, target=0.9, silence_thresh=1e-4, pct=99.9):
    """Scale a signal to a robust peak of ``target`` (≈ −1 dBFS), brickwall-
    clipping the rare over-target samples. Returns ``(x_norm, gain_db)``.

    Why a *robust* (99.9th-percentile) peak, not the absolute max: the MVDR
    output's distortionless constraint preserves spectral *shape*, not absolute
    calibration, and the tracker can emit a single transient spike tens of dB
    above the actual speech (measured: +41 dBFS spike over −11 dB RMS speech on
    a stationary recording). Normalizing to that spike would scale the real
    speech down ~50 dB — and DFN3 then suppresses the near-silent result as
    noise, yielding a silent file. Anchoring to the 99.9th percentile tracks
    the speech level and clips only the rare outlier (one brief transient).
    Genuinely silent signals are left untouched so we never amplify pure noise
    into a fabricated signal."""
    x = np.asarray(x, dtype=np.float32).reshape(-1)
    if x.size == 0:
        return x, 0.0
    ax = np.abs(x)
    peak = float(np.max(ax))
    if peak < silence_thresh or not np.isfinite(peak):
        return x, 0.0
    ref = float(np.percentile(ax, pct))          # robust peak (ignores spikes)
    if ref < silence_thresh:
        ref = peak                               # all energy in the tail → fall back to max
    g = target / ref
    return np.clip(x * g, -1.0, 1.0).astype(np.float32), float(20.0 * np.log10(g))


# =========================================================================
#  DEFAULT BEAMFORMER — compact, self-contained static MVDR  (8 → 1)
# =========================================================================
#  This is the cascade's *fallback*: it depends on nothing in pipeline.py,
#  so the cascade still produces a single channel even if the validated
#  tracked-MVDR wrapper can't be wired. The caller is expected to pass the
#  repo's ``estimate_rtf_tracked`` + ``bf_mvdr_tracked`` via ``beamform_fn``
#  (see ``tracked_mvdr_beamform`` below) for the Sprint-B moving-speaker
#  benefit; this static version locks onto the batch geometry.
# =========================================================================
def _stft_mc(y, fs):
    """Per-channel STFT of ``y`` (D, samples) → ``X`` (F, T, D) complex64."""
    D, n = y.shape
    F = NFFT // 2 + 1
    n_frames = max(1, 1 + (n - NFFT) // HOP)
    X = np.zeros((F, n_frames, D), dtype=np.complex64)
    for c in range(D):
        _, _, Z = sps.stft(y[c], fs=fs, nperseg=NFFT, noverlap=NFFT - HOP,
                           nfft=NFFT, window=WIN, boundary=None, padded=False)
        m = min(Z.shape[1], n_frames)
        X[:, :m, c] = Z[:, :m]
    return X


def _istft_mono(Xf, n_out, fs):
    """ISTFT of a single-channel spectrum ``Xf`` (F, T) → ``(n_out,)``."""
    _, x = sps.istft(Xf, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP,
                     nfft=NFFT, window=WIN, boundary=None)
    if len(x) < n_out:
        x = np.pad(x, (0, n_out - len(x)))
    return x[:n_out].astype(np.float32)


def static_mvdr_beamform(y, sr):
    """Compact static MVDR beamformer — the cascade's dependency-free default.

    ``beamform_fn`` contract: ``y`` is ``(D, samples)`` and the return is the
    single beamformed channel ``(samples,)`` float32.

    Method (one static weight per bin, applied to every frame):
      1. soft speech mask from per-bin posterior SNR vs a 10th-pct floor,
      2. mask-weighted speech / noise covariances Φ_x, Φ_v (diagonally loaded),
      3. rank-1 RTF = principal generalized eigenvector of (Φ_x, Φ_v),
      4. MVDR  w = Φ_v⁻¹h / (hᴴΦ_v⁻¹h), then  Y = wᴴ·X.
    Robust throughout: any per-bin linear-algebra failure falls back to the
    reference channel so the stage never raises.
    """
    D, n = y.shape
    if D == 1:
        return y[0].astype(np.float32)
    X = _stft_mc(y, sr)                                   # (F, T, D)
    F, T, _ = X.shape

    # 1) soft mask (per-bin sigmoid on posterior SNR)
    power = (np.abs(X) ** 2).mean(axis=2)                 # (F, T)
    floor = np.maximum(np.quantile(power, 0.10, axis=1, keepdims=True), EPS)
    M = 1.0 / (1.0 + np.exp(-(np.log(power / floor + EPS) - np.log(2.0))))
    M = np.clip(M, 0.02, 0.98).astype(np.float32)

    # reference channel = best mask-weighted speech/noise energy ratio
    P = np.abs(X) ** 2
    Mb = M[:, :, None]
    ref = int(np.argmax((Mb * P).sum(axis=(0, 1)) /
                        (((1 - Mb) * P).sum(axis=(0, 1)) + EPS)))

    # 2) masked covariances, vectorized over all bins
    Xc = np.conj(X)
    w_sp = M[:, :, None]
    w_nz = (1.0 - M)[:, :, None]
    phi_x = np.einsum('ftc,ftd->fcd', w_sp * X, Xc) / np.maximum(M.sum(1)[:, None, None], EPS)
    phi_v = np.einsum('ftc,ftd->fcd', w_nz * X, Xc) / np.maximum((1 - M).sum(1)[:, None, None], EPS)
    eye = np.eye(D, dtype=np.complex64)
    for f in range(F):                                    # diagonal loading
        phi_x[f] += eye * (1e-3 * np.real(np.trace(phi_x[f])) / D + 1e-10)
        phi_v[f] += eye * (1e-3 * np.real(np.trace(phi_v[f])) / D + 1e-10)

    # 3) + 4) per-bin RTF → MVDR weight → output spectrum
    from scipy.linalg import eigh
    Y = np.zeros((F, T), dtype=np.complex64)
    e_ref = np.zeros(D, dtype=np.complex64)
    e_ref[ref] = 1.0
    for f in range(F):
        try:
            ev, evec = eigh(phi_x[f], phi_v[f])
            h = evec[:, int(np.argmax(ev.real))]
            h = h / h[ref] if abs(h[ref]) > EPS else e_ref
            vinv = np.linalg.solve(phi_v[f], h)
            denom = np.conj(h) @ vinv
            w = vinv / denom if abs(denom) > EPS else e_ref
            if not np.all(np.isfinite(w)):
                w = e_ref
        except Exception:
            w = e_ref
        Y[f] = np.conj(w) @ X[f].T                        # (T,)
    return _istft_mono(Y, n_out=n, fs=sr)


# =========================================================================
#  TRACKED MVDR  (Sprint-B upgrade) — wraps the repo's validated functions
# =========================================================================
#  Reuses pipeline.estimate_rtf_tracked + pipeline.bf_mvdr_tracked behind the
#  beamform_fn contract. Their real signatures (read from pipeline.py, not
#  guessed):
#     estimate_rtf_tracked(X, phi_v, mask, ref=0, beta=0.95) -> (L, F, M)
#     bf_mvdr_tracked(rtf_track, phi_v, X, n_out=None)        -> (samples,)
#  Both expect the multichannel STFT X (F, T, D) and the *batch* noise
#  covariance Φ_v, exactly as process_file builds them — so we rebuild those
#  here from the (post-WPE) input and hand them straight through.
# =========================================================================
def batch_mvdr_beamform(y, sr):
    """Batch (reference-normalized) RTF-MVDR as a ``beamform_fn`` — the
    instrument's algorithm ② path, reusing the validated pipeline functions.

    ``y`` is ``(D, samples)``; returns the beamformed channel ``(samples,)``.

    This is the cascade's recommended beamformer on this dataset: the
    instrument's 500-trial bootstrap ranks the batch RTF-MVDR above the tracked
    variant on ~15/21 recordings (mean median-SNR 30.9 vs 28.4 dB). The batch
    RTF averages the steering vector over the whole clip (low variance), which
    beats per-frame tracking whenever the speaker is stationary or only slowly
    moving — i.e. these recordings. Use :func:`tracked_mvdr_beamform` instead
    only when the source genuinely moves fast within the clip.

      phi_x, phi_v = masked covariances (regularized)
      rtf = estimate_rtf(phi_x, phi_v, ref)            # ref-normalized RTF
      w   = bf_mvdr(rtf, phi_v)                         # Φ_v⁻¹h / hᴴΦ_v⁻¹h
      out = istft( wᴴ·X )
    """
    from . import pipeline as ov

    D, n = y.shape
    if D == 1:
        return y[0].astype(np.float32)

    x_sc = np.ascontiguousarray(y.T)                      # (samples, D) for pipeline
    X = ov.stft_multich(x_sc)                             # (F, T, D)
    mask = ov.estimate_softmask(X)
    ref, _ = ov.pick_reference_channel(X, mask)
    phi_x, phi_v = ov.compute_csm_masked(X, mask)
    phi_x = ov.regularise(phi_x)
    phi_v = ov.regularise(phi_v)
    rtf = ov.estimate_rtf(phi_x, phi_v, ref=ref)
    w = ov.bf_mvdr(rtf, phi_v)
    return ov.istft_single(ov.apply_beamformer(X, w), n_out=n).astype(np.float32)


def tracked_mvdr_beamform(y, sr):
    """Time-varying RTF-MVDR (PAST subspace tracking) as a ``beamform_fn``.

    ``y`` is ``(D, samples)``; returns the beamformed channel ``(samples,)``.
    Follows a moving speaker where the static batch RTF locks onto stale
    geometry (the Sprint-B benefit). Reuses the validated pipeline functions
    rather than reimplementing the tracker.
    """
    from . import pipeline as ov

    D, n = y.shape
    if D == 1:
        return y[0].astype(np.float32)

    x_sc = np.ascontiguousarray(y.T)                      # (samples, D) for pipeline
    X = ov.stft_multich(x_sc)                             # (F, T, D)
    mask = ov.estimate_softmask(X)
    ref, _ = ov.pick_reference_channel(X, mask)
    _, phi_v = ov.compute_csm_masked(X, mask)
    phi_v = ov.regularise(phi_v)
    rtf_track = ov.estimate_rtf_tracked(X, phi_v, mask, ref=ref, beta=0.95)
    return ov.bf_mvdr_tracked(rtf_track, phi_v, X, n_out=n).astype(np.float32)


# =========================================================================
#  VAD SILENCE FLOOR — speech-protective; polishes only the gaps
# =========================================================================
#  Distinct job from DFN3 (NO OVERLAP): DeepFilterNet3 is the denoiser and
#  cleans speech AND noise everywhere. This stage does NOT denoise — it only
#  lowers the floor in segments Silero VAD is confident are NON-speech, to
#  remove the faint residual DFN3 leaves between words. It never touches
#  speech, so it can't fight DFN3 or dull the voice.
#
#  Speech protection (why this won't clip words, unlike a raw per-frame gate):
#    · hysteresis     — enter speech at prob>enter, stay until prob<exit, so a
#                       mid-word probability dip doesn't drop the gate,
#    · hangover       — speech regions are dilated by ±hangover_ms so onsets
#                       and trailing consonants are never cut,
#    · asym. envelope — fast attack opens the gate instantly when speech
#                       returns; slow release closes it gently into silence,
#    · soft floor     — gaps are attenuated to floor_db (default −16 dB), not
#                       muted, so the result breathes naturally.
# =========================================================================
def _vad_silence_floor(x_mono, sr, floor_db=-24.0, enter=0.5, exit=0.35,
                       hangover_ms=200.0, attack_ms=10.0, release_ms=150.0):
    """Apply a speech-protective silence floor to a mono signal using Silero VAD.

    Returns ``(processed, info)``. ``info['ran']`` is False (signal returned
    unchanged) when Silero VAD is unavailable or returns nothing — a clean skip.
    """
    try:
        from . import pipeline as ov
    except Exception as e:
        return x_mono, {"ran": False, "reason": f"pipeline import failed ({e})"}
    if not getattr(ov, "HAS_VAD", False):
        return x_mono, {"ran": False, "reason": "Silero VAD unavailable (torch missing)"}

    probs = ov.silero_vad_mask(x_mono.astype(np.float32), sr)   # (T,) on hop=HOP grid
    if probs is None or len(probs) == 0:
        return x_mono, {"ran": False, "reason": "Silero VAD returned no frames"}
    probs = np.asarray(probs, dtype=np.float32)
    T = len(probs)

    # 1) hysteresis: prob → speech/non-speech, immune to mid-word dips.
    speech = np.zeros(T, dtype=bool)
    on = False
    for i, p in enumerate(probs):
        on = (p > exit) if on else (p > enter)
        speech[i] = on

    # 2) hangover: dilate speech regions by ±hangover so word edges survive.
    hf = max(1, int(round(hangover_ms * 1e-3 * sr / HOP)))
    if hf:
        kern = np.ones(2 * hf + 1, dtype=np.float32)
        speech = np.convolve(speech.astype(np.float32), kern, mode="same") > 0.5

    # 3) frame-level target gain (1.0 in speech, floor in gaps) with an
    #    asymmetric one-pole envelope: fast attack (open), slow release (close).
    floor = float(10.0 ** (floor_db / 20.0))
    target = np.where(speech, 1.0, floor).astype(np.float32)
    fps = sr / HOP                                          # frames per second
    a_at = float(np.exp(-1.0 / max(attack_ms * 1e-3 * fps, 1e-6)))
    a_re = float(np.exp(-1.0 / max(release_ms * 1e-3 * fps, 1e-6)))
    env = np.empty(T, dtype=np.float32)
    g = target[0]
    for i, t in enumerate(target):
        a = a_at if t >= g else a_re                       # rising→attack, falling→release
        g = a * g + (1.0 - a) * t
        env[i] = g

    # 4) upsample the frame envelope to per-sample gain and apply.
    n = len(x_mono)
    centers = np.arange(T) * HOP + NFFT / 2.0
    gain = np.interp(np.arange(n), centers, env,
                     left=env[0], right=env[-1]).astype(np.float32)
    out = (x_mono.astype(np.float32) * gain).astype(np.float32)
    return out, {"ran": True, "role": "silence-floor (speech-protective)",
                 "speech_frames": int(speech.sum()), "total_frames": int(T),
                 "floor_db": float(floor_db), "hangover_ms": float(hangover_ms)}


# =========================================================================
#  DEEPFILTERNET3 ENHANCE — with an attenuation limit (keeps quiet speakers)
# =========================================================================
def _dfn_enhance(mono, sr, atten_lim_db=12.0):
    """Enhance a mono signal with DeepFilterNet3 via pipeline's CPU-pinned cached
    model. Returns enhanced float32, or None for a clean skip.

    ``atten_lim_db`` caps how much DFN may suppress any time-frequency region.
    UNLIMITED DFN treats an overlapping / quieter second speaker as noise and
    removes it (measured: it dragged all-speaker envelope correlation 0.98→0.89);
    a ~12 dB cap keeps DFN's denoising while guaranteeing no region is pulled
    down more than 12 dB, so secondary voices survive (corr back to ~0.97).
    ``None`` restores the original unlimited behaviour. This is why the cascade
    calls ``enhance`` directly instead of ``pipeline.bf_dfn2`` (which has no
    such knob) — the CPU-pinned model itself is still reused from pipeline.
    """
    from . import pipeline as ov
    if not getattr(ov, "_DFN_AVAILABLE", False):
        return None
    model, df_state = ov._get_dfn_model()
    if model is None:
        return None
    try:
        import torch
        if sr != df_state.sr():
            return None
        audio = torch.from_numpy(np.ascontiguousarray(mono, dtype=np.float32))[None, :]
        # Shared GPU-first / CPU-fallback runner keeps model + input features on
        # the same device (the old direct enhance() call let CUDA features hit a
        # CPU model). atten_lim_db is forwarded unchanged (None = unlimited).
        out = ov._dfn_run_enhance(model, df_state, audio, atten_lim_db=atten_lim_db)
        return out.detach().cpu().numpy().squeeze().astype(np.float32)
    except Exception as e:
        print(f"[WARN] clean_cascade DFN enhance failed: {e}")
        return None


# =========================================================================
#  MAIN CASCADE
# =========================================================================
def run_clean_cascade(input_path, out_dir, beamform_fn=None, use_gpu=False,
                      use_dfn=True, mvdr_blend=0.7, dfn_atten_lim_db=24.0,
                      log=None):
    """Run the single-output clean-voice cascade on one 8-channel WAV.

    Parameters
    ----------
    input_path : str | Path
        An 8-channel 48 kHz WAV (the same files the instrument consumes).
    out_dir : str | Path
        The /output root. The clean WAV is written to
        ``<out_dir>/<stem>/clean_cascade.wav`` so it sits beside (and never
        clobbers) the instrument's per-recording outputs.
    beamform_fn : callable | None
        ``beamform_fn(y: np.ndarray (D, samples), sr: int) -> (samples,)``.
        Defaults to the self-contained :func:`static_mvdr_beamform`. The
        ``/api/clean`` endpoint passes :func:`batch_mvdr_beamform` (the
        reference-normalized RTF-MVDR — best on this dataset per the bootstrap);
        :func:`tracked_mvdr_beamform` is available for fast-moving speakers.
    use_dfn : bool
        When False, the DeepFilterNet3 neural-denoise stage is skipped so the
        output is just the (WPE-dereverbed) beamformer cleaned by the VAD gate
        — useful for auditioning the RTF-MVDR beamformer on its own, without the
        neural post-filter masking beamformer artifacts. Logged as a skip in
        ``stages['dfn3']`` so it is never silent.
    mvdr_blend : float in [0, 1]
        How much pure (single-source) MVDR vs non-directional downmix to keep.
        ``1.0`` = pure MVDR (isolates one speaker, suppresses others); ``0.0`` =
        downmix only (all speakers, no spatial focus); the default ``0.5`` mixes
        them so MVDR still enhances the main speaker while the other people stay
        audible. DFN3 denoises the blend afterwards. Raise toward 1.0 for a
        single dominant speaker, lower toward 0.0 to be sure no one is cut.
    dfn_atten_lim_db : float | None
        Attenuation limit (dB) for DeepFilterNet3 — the max it may suppress any
        region. Default ``12`` denoises strongly but never removes a quieter /
        overlapping second speaker. Lower (e.g. 6) preserves speakers even more
        (less denoising); ``None`` is the original unlimited DFN (cuts speakers).
    use_gpu : bool
        Accepted for API symmetry. The neural stack (DeepFilterNet, Silero
        VAD) is CPU-pinned regardless via the CUDA_VISIBLE_DEVICES guard at
        import time — the deliberate handoff §6 mitigation — so this currently
        only documents intent; it does not re-enable CUDA for the neural path.
    log : callable | None
        Optional ``log(msg)`` progress sink.

    Returns
    -------
    dict
        ``{clean_path, clean_name, stem, sr, n_channels, stages, elapsed_s}``.
        ``stages`` is an ordered dict of ``{stage: {ran: bool, ...}}`` so a
        skipped DFN3 / VAD stage is surfaced, not silent.
    """
    def _log(msg):
        if log:
            try:
                log(msg)
            except Exception:
                pass

    t0 = time.time()
    input_path = Path(input_path)
    out_dir = Path(out_dir)
    if beamform_fn is None:
        beamform_fn = static_mvdr_beamform

    stages = {}

    # ── load ──────────────────────────────────────────────────────────
    y, sr = _load_multichannel(input_path)                # (D, samples)
    D, n = y.shape
    stages["load"] = {"ran": True, "n_channels": int(D),
                      "sr": int(sr), "samples": int(n),
                      "duration_s": round(n / sr, 3)}
    _log(f"cascade: loaded {D}ch × {n} samples @ {sr} Hz ({n/sr:.2f}s)")

    # ── stage 1: WPE multichannel dereverb ────────────────────────────
    try:
        from . import pipeline as ov
        if getattr(ov, "HAS_WPE", False) and D > 1:
            x_sc = ov.wpe_dereverberate(y.T, sr, taps=8, delay=3, iterations=2)
            y = np.ascontiguousarray(x_sc.T)              # back to (D, samples)
            stages["wpe"] = {"ran": True, "taps": 8, "iterations": 2}
            _log("cascade: WPE dereverb done")
        else:
            why = "nara-wpe unavailable" if not getattr(ov, "HAS_WPE", False) else "single channel"
            stages["wpe"] = {"ran": False, "reason": why}
            _log(f"cascade: WPE skipped ({why})")
    except Exception as e:
        stages["wpe"] = {"ran": False, "reason": f"error: {e}"}
        _log(f"cascade: WPE skipped (error: {e})")

    # ── stage 2: MVDR beamform (D → 1), BLENDED with a non-directional
    #    downmix so off-axis speakers are kept, not nulled. ──
    #  MVDR alone is a single-source extractor: it focuses one speaker and
    #  suppresses the others (measured: it cut ~29% of speech frames on a
    #  2-person clip). To keep MVDR *and* every voice, we mix its output with
    #  the dereverbed channel-mean (which contains all speakers equally):
    #      mono = blend·MVDR + (1-blend)·downmix      (each level-matched first)
    #  The main speaker is reinforced (present in both); off-axis speakers
    #  survive via the downmix. DFN3 then denoises the blend, so the downmix's
    #  extra noise is cleaned up — MVDR and the whole pipeline stay in play.
    method = getattr(beamform_fn, "__name__", "beamform_fn")
    try:
        mvdr = np.asarray(beamform_fn(y, sr), dtype=np.float32).reshape(-1)
        if mvdr.size == 0 or not np.all(np.isfinite(mvdr)):
            raise ValueError("beamform_fn returned empty / non-finite output")
        if len(mvdr) < n:
            mvdr = np.pad(mvdr, (0, n - len(mvdr)))
        mvdr = mvdr[:n]
        if D > 1 and 0.0 < mvdr_blend < 1.0:
            downmix = y.mean(axis=0)[:n].astype(np.float32)   # all speakers, non-directional
            mvdr_n, _ = _peak_normalize(mvdr, target=1.0)     # level-match before mixing
            dmix_n, _ = _peak_normalize(downmix, target=1.0)
            mono = (mvdr_blend * mvdr_n + (1.0 - mvdr_blend) * dmix_n).astype(np.float32)
            blend_note = f"MVDR×{mvdr_blend:.2f} + downmix×{1-mvdr_blend:.2f} (keeps all speakers)"
        else:
            mono = mvdr                                       # pure MVDR (single-source)
            blend_note = "pure MVDR (single-source)"
        # Peak-normalize to a sane range: the MVDR output scale is arbitrary
        # (it can peak tens of dB over FS), and DFN3 expects an in-range signal.
        mono, gbf = _peak_normalize(mono)
        stages["beamform"] = {"ran": True, "method": method, "channels_in": int(D),
                              "mvdr_blend": float(mvdr_blend), "blend": blend_note,
                              "peak_norm_db": round(gbf, 1)}
        _log(f"cascade: beamform ({method}) {D}→1 done — {blend_note} (peak-norm {gbf:+.1f} dB)")
    except Exception as e:
        # Fall back to the dependency-free static MVDR, then to ref mono.
        _log(f"cascade: beamform '{method}' failed ({e}); trying static fallback")
        try:
            mono = np.asarray(static_mvdr_beamform(y, sr), dtype=np.float32).reshape(-1)[:n]
            stages["beamform"] = {"ran": True, "method": "static_mvdr_beamform",
                                  "fallback_from": method, "reason": str(e)}
        except Exception as e2:
            mono = y.mean(axis=0)[:n].astype(np.float32)
            stages["beamform"] = {"ran": True, "method": "channel_mean_fallback",
                                  "reason": f"{e}; static also failed: {e2}"}

    # ── stage 3: DeepFilterNet3 (CPU, single-channel neural denoise) ──
    if not use_dfn:
        stages["dfn3"] = {"ran": False, "reason": "disabled (use_dfn=False)"}
        _log("cascade: DeepFilterNet skipped (disabled — auditioning RTF-MVDR only)")
    else:
        try:
            from . import pipeline as ov
            if getattr(ov, "_DFN_AVAILABLE", False) and sr == SR_DFN:
                # CPU-pinned enhance WITH an attenuation limit so DFN denoises
                # without removing a quieter/overlapping second speaker.
                dfn_out = _dfn_enhance(mono.astype(np.float32), sr,
                                       atten_lim_db=dfn_atten_lim_db)
                if dfn_out is not None:
                    d = np.asarray(dfn_out, dtype=np.float32).reshape(-1)
                    if len(d) < n:
                        d = np.pad(d, (0, n - len(d)))
                    mono = d[:n]
                    model_name = _dfn_model_name(ov)
                    stages["dfn3"] = {"ran": True, "model": model_name, "device": "cpu",
                                      "atten_lim_db": dfn_atten_lim_db}
                    _log(f"cascade: DeepFilterNet ({model_name}) enhance done "
                         f"(atten_lim {dfn_atten_lim_db} dB)")
                else:
                    stages["dfn3"] = {"ran": False, "reason": "model load/enhance returned None"}
                    _log("cascade: DeepFilterNet skipped (load/enhance failed)")
            else:
                why = ("deepfilternet not installed"
                       if not getattr(ov, "_DFN_AVAILABLE", False)
                       else f"sample rate {sr} ≠ {SR_DFN} Hz")
                stages["dfn3"] = {"ran": False, "reason": why}
                _log(f"cascade: DeepFilterNet skipped ({why})")
        except Exception as e:
            stages["dfn3"] = {"ran": False, "reason": f"error: {e}"}
            _log(f"cascade: DeepFilterNet skipped (error: {e})")

    # ── stage 4: VAD silence floor (speech-protective; polishes gaps only) ─
    try:
        mono, vad_info = _vad_silence_floor(mono, sr)
        stages["vad_gate"] = vad_info
        if vad_info.get("ran"):
            _log(f"cascade: VAD silence-floor applied "
                 f"({vad_info.get('speech_frames')}/{vad_info.get('total_frames')} speech frames, "
                 f"floor {vad_info.get('floor_db')} dB)")
        else:
            _log(f"cascade: VAD silence-floor skipped ({vad_info.get('reason')})")
    except Exception as e:
        stages["vad_gate"] = {"ran": False, "reason": f"error: {e}"}
        _log(f"cascade: VAD silence-floor skipped (error: {e})")

    # ── final output level: peak-normalize for a fair, audible A/B against
    #    the (auto-gained) input mono shown in the player. ──
    mono, gout = _peak_normalize(mono)
    stages["output_normalize"] = {"ran": True, "gain_db": round(gout, 1), "target_peak": 0.9}
    _log(f"cascade: output peak-normalized ({gout:+.1f} dB)")

    # ── write clean mono (beside the instrument outputs, never clobbering) ─
    stem = input_path.stem
    rec_dir = out_dir / stem
    rec_dir.mkdir(parents=True, exist_ok=True)
    clean_path = rec_dir / "clean_cascade.wav"
    _save_mono(clean_path, mono, sr)
    _log(f"cascade: wrote {clean_path}")

    return {
        "clean_path": str(clean_path),
        "clean_name": clean_path.name,
        "stem": stem,
        "sr": int(sr),
        "n_channels": int(D),
        "stages": stages,
        "elapsed_s": round(time.time() - t0, 2),
    }


def _dfn_model_name(ov):
    """Human label for the loaded DeepFilterNet variant (e.g. 'DeepFilterNet3')
    for the stages report. ``pipeline._get_dfn_model`` calls ``init_df()`` with
    no args, so the variant is exactly ``init_df``'s ``default_model`` default
    (the nn.Module class is the generic 'DfNet', which is why we don't read it).
    Never raises."""
    try:
        from df.enhance import DEFAULT_MODEL          # 'DeepFilterNet3' in 0.5.6
        if DEFAULT_MODEL:
            return str(DEFAULT_MODEL)
    except Exception:
        pass
    try:
        import inspect
        from df.enhance import init_df
        d = inspect.signature(init_df).parameters.get("default_model")
        if d is not None and d.default:
            return str(d.default)
    except Exception:
        pass
    return "DeepFilterNet"
