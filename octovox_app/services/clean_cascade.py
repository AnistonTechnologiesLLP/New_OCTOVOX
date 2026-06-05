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

  Chain (fixed, intentional order):

    8-ch  →  WPE dereverb (multichannel)
          →  MVDR beamform (8 → 1)
          →  DeepFilterNet3 (CPU)
          →  Silero VAD gate
          →  clean mono

Every stage is *optional in practice*: if a dependency is missing or a
stage raises, the cascade logs a clean skip and carries the signal forward
unchanged (a graceful no-op, never a crash). The returned ``stages`` dict
records exactly which stages fired, so a skip is visible — not silent.

──────────────────────────────────────────────────────────────────────────
  NEURAL-STACK CPU PIN (handoff §6)
──────────────────────────────────────────────────────────────────────────
DeepFilterNet's CUDA synthesis path is buggy on CUDA-equipped Windows hosts
(``cuda.FloatTensor`` vs ``FloatTensor`` mismatch). That bug is package /
torch-device related, NOT version-specific — DFN3 does not fix it — so we
keep the same structural mitigation as ``pipeline.py`` / ``pilot_dfn2.py``:
hide every GPU from torch at the ENVIRONMENT level *before* torch is ever
imported. ``setdefault`` makes it an opt-OUT (a caller who pre-sets
CUDA_VISIBLE_DEVICES keeps torch on the GPU and accepts the risk).
=========================================================================
"""
import os

# ── Belt #1: pin the whole torch stack (DeepFilterNet AND Silero VAD) to
#    CPU before torch is imported anywhere. Must be at module top. ──
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
#  VAD GATE — Silero per-frame speech probability → smooth per-sample gate
# =========================================================================
def _vad_gate(x_mono, sr, floor=0.10, smooth_ms=40.0):
    """Attenuate non-speech regions of a mono signal using Silero VAD.

    Returns ``(gated_signal, info)``. ``info['ran']`` is False (and the signal
    is returned unchanged) when Silero VAD is unavailable or returns nothing —
    a clean skip, never a crash.

    The gate is *soft*: a per-sample gain in ``[floor, 1]`` (floor ≈ −20 dB by
    default) built from the per-frame VAD probability, then smoothed with a
    short moving average so it fades rather than clicks. A hard mute would chop
    word onsets and add zipper artifacts; the floor preserves room tone.
    """
    try:
        from . import pipeline as ov
    except Exception as e:
        return x_mono, {"ran": False, "reason": f"pipeline import failed ({e})"}
    if not getattr(ov, "HAS_VAD", False):
        return x_mono, {"ran": False, "reason": "Silero VAD unavailable (torch missing)"}

    probs = ov.silero_vad_mask(x_mono.astype(np.float32), sr)   # (n_frames,) on hop=HOP grid
    if probs is None or len(probs) == 0:
        return x_mono, {"ran": False, "reason": "Silero VAD returned no frames"}

    n = len(x_mono)
    # Frame k is centered at sample k*HOP + NFFT/2. Map each sample to its
    # nearest frame's probability, then convert to a [floor, 1] gain.
    frame_centers = np.arange(len(probs)) * HOP + NFFT / 2.0
    sample_idx = np.arange(n)
    g = np.interp(sample_idx, frame_centers, probs,
                  left=probs[0], right=probs[-1]).astype(np.float32)
    gain = floor + (1.0 - floor) * np.clip(g, 0.0, 1.0)

    # Smooth the gain envelope to avoid clicks at gate transitions.
    k = max(1, int(smooth_ms * 1e-3 * sr))
    if k > 1:
        kern = np.ones(k, dtype=np.float32) / k
        gain = np.convolve(gain, kern, mode="same").astype(np.float32)

    gated = (x_mono.astype(np.float32) * gain).astype(np.float32)
    speech_frames = int((probs > 0.5).sum())
    return gated, {"ran": True, "speech_frames": speech_frames,
                   "total_frames": int(len(probs)), "floor": float(floor)}


# =========================================================================
#  MAIN CASCADE
# =========================================================================
def run_clean_cascade(input_path, out_dir, beamform_fn=None, use_gpu=False,
                      use_dfn=True, log=None):
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

    # ── stage 2: MVDR beamform (D → 1) ────────────────────────────────
    method = getattr(beamform_fn, "__name__", "beamform_fn")
    try:
        mono = np.asarray(beamform_fn(y, sr), dtype=np.float32).reshape(-1)
        if mono.size == 0 or not np.all(np.isfinite(mono)):
            raise ValueError("beamform_fn returned empty / non-finite output")
        if len(mono) < n:
            mono = np.pad(mono, (0, n - len(mono)))
        mono = mono[:n]
        # Peak-normalize to a sane range: the MVDR output scale is arbitrary
        # (it can peak tens of dB over FS), and DFN3 expects an in-range signal.
        mono, gbf = _peak_normalize(mono)
        stages["beamform"] = {"ran": True, "method": method, "channels_in": int(D),
                              "peak_norm_db": round(gbf, 1)}
        _log(f"cascade: beamform ({method}) {D}→1 done (peak-norm {gbf:+.1f} dB)")
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
                dfn_out = ov.bf_dfn2(mono.astype(np.float32), sr)   # CPU-pinned init_df()/enhance()
                if dfn_out is not None:
                    d = np.asarray(dfn_out, dtype=np.float32).reshape(-1)
                    if len(d) < n:
                        d = np.pad(d, (0, n - len(d)))
                    mono = d[:n]
                    model_name = _dfn_model_name(ov)
                    stages["dfn3"] = {"ran": True, "model": model_name, "device": "cpu"}
                    _log(f"cascade: DeepFilterNet ({model_name}) enhance done")
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

    # ── stage 4: Silero VAD gate ──────────────────────────────────────
    try:
        mono, vad_info = _vad_gate(mono, sr)
        stages["vad_gate"] = vad_info
        if vad_info.get("ran"):
            _log(f"cascade: VAD gate applied "
                 f"({vad_info.get('speech_frames')}/{vad_info.get('total_frames')} speech frames)")
        else:
            _log(f"cascade: VAD gate skipped ({vad_info.get('reason')})")
    except Exception as e:
        stages["vad_gate"] = {"ran": False, "reason": f"error: {e}"}
        _log(f"cascade: VAD gate skipped (error: {e})")

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
