#!/usr/bin/env python3
"""
=========================================================================
  OCTOVOX — PRODUCTION VOICE PIPELINE  (single-output, fast, the main path)
=========================================================================
A production-style speech front-end that maps the classic conferencing /
ceiling-array DSP chain onto the 8-mic OCTOVOX input and emits ONE clean
mono file, fast (a small fraction of real-time). It is the app's primary
"clean voice" path; the 6-algorithm bootstrap *instrument* is no longer
surfaced in the UI, but its DSP lives on in ``pipeline.py`` and is reused
here wholesale.

  Requested production chain  →  where each stage runs:

    [1]  Mic capsules                         · the 8 WAV channels
    [2]  ADC / PDM→PCM / channel calibration  · calibrate_channels()
    [3]  High-pass + noise-floor estimation   · highpass() + estimate_noise_floor()
    [4]  VAD / speech detector                · pipeline.silero_vad_mask()
    [5]  DOA / talker tracking                · pipeline.srp_phat_doa() (block-wise)
    [6]  Beamforming / beam tracking          · batch/tracked RTF-MVDR (8→1)
    [7]  AEC w/ far-end reference             · aec_nlms()  (no-op unless ref given)
    [8]  Noise reduction + dereverb           · WPE (front-end) + Wiener/OM-LSA/DFN3
    [9]  Automix / gating / beam weighting     · automix() (VAD silence-floor)
    [10] AGC + EQ + limiter                   · agc_to_dbfs() + apply_eq() + soft_limit()
    [11] Dante/AVB/USB/analog output          · clean WAV (+ device playout via API)

Principled ordering note (the one deviation from the literal list): WPE
dereverberation is MULTICHANNEL and must run on the 8-mic array *before*
beamforming — you cannot dereverb a signal that has already been collapsed
to mono. So the "dereverb" half of stage [8] executes as a front-end step
(right after the high-pass), exactly as the validated clean-voice cascade
and every CHiME front-end do; the noise-reduction half of [8] runs on the
single beamformed channel. Both are reported under their stage names so the
order is explicit, never hidden.

Speed (the "very less time taken" requirement):
  · default NR is fast SPECTRAL (Wiener) — no neural cost. DeepFilterNet3 is
    opt-in via ``nr="dfn"`` (it is the slow stage).
  · WPE runs band-limited with light taps/iters (taps=5, iters=1).
  · every stage records its wall-clock into ``timings`` so the budget is
    measurable, and a skipped stage is surfaced in ``stages`` — never silent.

Neural-stack device policy: DFN runs GPU-first with a per-call CPU fallback,
keeping model + input features on one device (see ``pipeline._dfn_run_enhance``)
— the fix for the old ``cuda.FloatTensor`` vs ``FloatTensor`` mismatch, which
was a device-placement bug, not a DFN-CUDA-synthesis bug. Set OCTOVOX_FORCE_CPU=1
to restore the old hard CPU pin.
=========================================================================
"""
import os

# ── Opt-in CPU pin (OCTOVOX_FORCE_CPU=1): hide the GPU from torch before it is
#    imported anywhere. Off by default — the torch stack runs GPU-first now. ──
if os.environ.get("OCTOVOX_FORCE_CPU") == "1":
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

# Informational mirror only (parity/logging); the authoritative behavioral gate
# is pipeline._CFAR_MASK inside estimate_softmask. Default OFF.
CFAR_MASK = os.environ.get("OCTOVOX_CFAR_MASK") == "1"

import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
import scipy.signal as sps

# Reuse the cascade's validated I/O + beamformers + neural wrappers wholesale.
from . import clean_cascade as cc
from .clean_cascade import (
    _load_multichannel, _save_mono, _peak_normalize,
    batch_mvdr_beamform, tracked_mvdr_beamform,
    _vad_silence_floor, _dfn_enhance, SR_DFN,
    NFFT, HOP, WIN, EPS, SPEED_SOUND,
)


# =========================================================================
#  [2]  CHANNEL GAIN CALIBRATION
# =========================================================================
def calibrate_channels(y, fs, max_gain_db=12.0, active_pct=70.0):
    """Equalize per-capsule sensitivity so all 8 mics share one level.

    Real arrays have mic-to-mic sensitivity spread (and per-channel preamp
    gain). The MVDR covariance math assumes matched channels, so we bring each
    channel's speech-band RMS to the array median. The gain is computed over the
    *louder* frames only (``active_pct`` percentile of per-frame energy) so a
    channel is calibrated on speech, not on its noise floor, and is clamped to
    ``±max_gain_db`` so a dead/disconnected channel is never boosted into a wall
    of noise.

    ``y`` is ``(D, samples)``; returns ``(y_cal, info)``.
    """
    D, n = y.shape
    if D == 1:
        return y, {"ran": False, "reason": "single channel"}
    # Per-channel RMS over the active (loud) portion of each channel. Vectorized
    # across channels AND frames (reshape into non-overlapping 30 ms blocks) — the
    # same per-frame energies / active-percentile gate as the old double loop.
    win = int(0.030 * fs)
    if win < n:
        n_fr = 1 + (n - win) // win
        frames = y[:, :n_fr * win].reshape(D, n_fr, win).astype(np.float64)
        e = (frames ** 2).mean(axis=2) + EPS                  # (D, n_fr)
        thr = np.percentile(e, active_pct, axis=1, keepdims=True)
        active = np.where(e >= thr, e, np.nan)
        rms = np.sqrt(np.nanmean(active, axis=1) + EPS)
    else:
        rms = np.sqrt(np.mean(y.astype(np.float64) ** 2, axis=1) + EPS)
    target = float(np.median(rms))
    g = target / np.maximum(rms, EPS)
    gmax = 10.0 ** (max_gain_db / 20.0)
    g = np.clip(g, 1.0 / gmax, gmax)
    y_cal = (y * g[:, None]).astype(np.float32)
    return y_cal, {"ran": True, "gains_db": [round(20.0 * np.log10(gi), 2) for gi in g],
                   "target_rms_dbfs": round(20.0 * np.log10(target + EPS), 1),
                   "max_gain_db": max_gain_db}


# =========================================================================
#  [2b]  MIC HEALTH DIAGNOSTIC  (read-only — runs on the RAW input)
# =========================================================================
def mic_health_report(y, fs, dead_db=-25.0, warn_db=3.0, fault_db=6.0,
                      clip_thresh=0.99, clip_pct=1.0, active_pct=70.0):
    """Per-capsule health: flag DEAD / CLIP / FAULT / WARN / OK channels.

    Runs on the RAW input (before :func:`calibrate_channels` equalizes levels)
    so a dead, disconnected, or deviant mic is still visible. Each channel's
    speech-band RMS is measured over its *louder* frames (the ``active_pct``
    percentile, so the verdict reflects speech, not the noise floor) and compared
    to the array median; hard clipping is checked separately on the raw peak.
    Ported and extended from the senior repo's
    ``PolarisArrayInput.get_mic_health_report``. READ-ONLY — never alters audio.

    Status rules (per channel, vs the array-median RMS):
      · CLIP  — ``>= clip_pct`` % of samples at/above ``clip_thresh`` full-scale
      · DEAD  — RMS is ``<= dead_db`` below the median (disconnected / silent mic)
      · FAULT — |RMS deviation| ``>= fault_db``
      · WARN  — |RMS deviation| ``>= warn_db``
      · OK    — otherwise

    ``y`` is ``(D, samples)``. Returns an info dict; never raises.
    """
    try:
        D, n = y.shape
        if D < 2:
            return {"ran": False, "reason": "single channel"}
        win = int(0.030 * fs)
        # Per-channel peak / clip fraction / active-band RMS, vectorized across
        # channels (and frames) — identical statistics to the old per-channel loop.
        absy = np.abs(y)
        peak = absy.max(axis=1) + EPS
        clip_frac = (absy >= clip_thresh).mean(axis=1) * 100.0
        if win < n:
            n_fr = 1 + (n - win) // win
            frames = y[:, :n_fr * win].reshape(D, n_fr, win).astype(np.float64)
            e = (frames ** 2).mean(axis=2) + EPS                  # (D, n_fr)
            thr = np.percentile(e, active_pct, axis=1, keepdims=True)
            active = np.where(e >= thr, e, np.nan)
            rms = np.sqrt(np.nanmean(active, axis=1) + EPS)
        else:
            rms = np.sqrt(np.mean(y.astype(np.float64) ** 2, axis=1) + EPS)
        ref = float(np.median(rms))
        per_mic, counts = [], {"OK": 0, "WARN": 0, "FAULT": 0, "DEAD": 0, "CLIP": 0}
        for c in range(D):
            dev_db = 20.0 * np.log10((rms[c] + EPS) / (ref + EPS))
            if clip_frac[c] >= clip_pct:
                status = "CLIP"
            elif dev_db <= dead_db:
                status = "DEAD"
            elif abs(dev_db) >= fault_db:
                status = "FAULT"
            elif abs(dev_db) >= warn_db:
                status = "WARN"
            else:
                status = "OK"
            counts[status] += 1
            per_mic.append({"mic": c, "rms_dbfs": round(20.0 * np.log10(rms[c] + EPS), 1),
                            "dev_db": round(float(dev_db), 1),
                            "peak_dbfs": round(20.0 * np.log10(peak[c]), 1),
                            "clip_pct": round(clip_frac[c], 2), "status": status})
        bad = [m["mic"] for m in per_mic if m["status"] != "OK"]
        return {"ran": True, "n_channels": int(D), "all_ok": bool(not bad),
                "ref_rms_dbfs": round(20.0 * np.log10(ref + EPS), 1),
                "counts": counts, "flagged_mics": bad, "per_mic": per_mic}
    except Exception as e:
        return {"ran": False, "reason": f"error: {e}"}


# =========================================================================
#  [3]  HIGH-PASS FILTER  +  NOISE-FLOOR ESTIMATION
# =========================================================================
def highpass(y, fs, cutoff_hz=80.0, order=4):
    """Zero-phase Butterworth high-pass on every channel — removes HVAC rumble,
    handling thumps and DC, below the speech band. ``y`` is ``(D, samples)``;
    returns ``(y_hp, info)``. Falls back to the input on any filter error."""
    try:
        sos = sps.butter(order, cutoff_hz, btype="highpass", fs=fs, output="sos")
        # One vectorized zero-phase pass over all channels (axis=-1) instead of a
        # per-channel Python loop — same filter, same result, less overhead.
        y_hp = sps.sosfiltfilt(sos, y, axis=-1).astype(np.float32)
        return y_hp, {"ran": True, "cutoff_hz": cutoff_hz, "order": order, "phase": "zero"}
    except Exception as e:
        return y, {"ran": False, "reason": f"error: {e}"}


def estimate_noise_floor(y, fs, pct=10.0):
    """Estimate the broadband noise floor (dBFS) from the quiet frames of the
    array downmix — the 10th-percentile per-bin power, summed to broadband.
    Informational (reported in ``stages``); confirms the HVAC/fan floor the
    downstream NR has to beat. Never raises."""
    try:
        mono = y.mean(axis=0).astype(np.float32)
        _, _, Z = sps.stft(mono, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP,
                           window=WIN, boundary=None)
        P = np.abs(Z) ** 2                                   # (F, T)
        noise_psd = np.percentile(P, pct, axis=1)            # per-bin quiet floor
        floor_rms = float(np.sqrt(np.sum(noise_psd) + EPS))
        return {"ran": True, "noise_floor_dbfs": round(20.0 * np.log10(floor_rms + EPS), 1),
                "percentile": pct}
    except Exception as e:
        return {"ran": False, "reason": f"error: {e}"}


# =========================================================================
#  [5·track]  TRACKING-PATH CONDITIONER  (noise-robust, phase-preserving)
# =========================================================================
def condition_tracking_path(y, fs, lo_hz=250.0, hi_hz=3500.0, order=4):
    """Condition a COPY of the array for talker tracking — a Biamp-style split
    where the *tracking* path is noise-robust and band-limited to speech, while
    the *audio* path (the beamformer input) is left untouched.

    ``track_doa`` and :func:`rtf_drift` both estimate *where* the talker is from
    inter-microphone differences. Out-of-band energy — sub-250 Hz HVAC rumble,
    high-frequency hiss / projector-fan whine — carries no useful talker
    direction but can pull those estimates toward the noise. Band-limiting the
    tracking signal to the speech range (``lo_hz``..``hi_hz``) removes that energy
    so the beam tracks the human, not the air-conditioner.

    CRITICAL — phase preservation. DOA/RTF depend on the *relative phase* between
    channels, so the tracking conditioner must be a SINGLE linear filter applied
    IDENTICALLY to every channel (a per-channel adaptive denoiser would give each
    mic a different phase and destroy the very cue the tracker reads). We use one
    zero-phase Butterworth band-pass (``sosfiltfilt``, same coefficients on all 8
    channels): it strips out-of-band noise while leaving every inter-channel
    phase relationship intact. This is the audio-vs-tracking *path split*, the
    transferable part of the Parlé design — NOT a latency trick (parallel paths
    do not halve latency; this pipeline is offline batch anyway).

    ``y`` is ``(D, samples)``; returns ``(y_track, info)``. Falls back to a copy
    of the input on any filter error so tracking never blocks the pipeline.
    """
    try:
        D, n = y.shape
        hi = min(hi_hz, 0.45 * fs)
        if hi <= lo_hz:
            return y.copy(), {"ran": False, "reason": "band collapsed for this sr"}
        sos = sps.butter(order, [lo_hz, hi], btype="bandpass", fs=fs, output="sos")
        # Single vectorized zero-phase band-pass across all channels — the SAME
        # coefficients on every channel (axis=-1), so inter-channel phase is
        # preserved exactly as the per-channel loop did, with less overhead.
        y_track = sps.sosfiltfilt(sos, y, axis=-1).astype(np.float32)
        return y_track, {"ran": True, "band_hz": [lo_hz, round(hi, 1)], "order": order,
                         "phase": "zero (common filter — inter-channel phase preserved)"}
    except Exception as e:
        return y.copy(), {"ran": False, "reason": f"error: {e}"}


# =========================================================================
#  [5]  DOA / TALKER TRACKING  (block-wise SRP-PHAT)
# =========================================================================
def track_doa(y, fs, mic_pos, n_blocks=3, move_thresh_deg=25.0):
    """Block-wise SRP-PHAT direction-of-arrival to follow the talker.

    Splits the clip into ``n_blocks`` and estimates the azimuth in each, reusing
    the instrument's ``srp_phat_doa``. The azimuth *spread* across blocks is the
    talker-movement signal that picks the beamformer in stage [6]: a wide spread
    means the source moved and the time-varying (tracked) MVDR should follow it;
    a tight spread means a static batch beam is both better and cheaper.

    Returns ``(info, moved: bool)``. Degrades to ``moved=False`` (use the cheap
    batch beam) on any failure, so DOA never blocks the pipeline.
    """
    from . import pipeline as ov
    try:
        D, n = y.shape
        x_sc = np.ascontiguousarray(y.T)                     # (samples, D)
        X = ov.stft_multich(x_sc)                            # (F, T, D)
        T = X.shape[1]
        if T < n_blocks * 2:
            n_blocks = 1
        az_list, el_list = [], []
        edges = np.linspace(0, T, n_blocks + 1).astype(int)
        for b in range(n_blocks):
            lo, hi = edges[b], max(edges[b] + 1, edges[b + 1])
            Xb = X[:, lo:hi, :]
            mask = ov.estimate_softmask(Xb)
            phi_x, phi_v = ov.compute_csm_masked(Xb, mask)
            phi_x = ov.regularise(phi_x)
            phi_v = ov.regularise(phi_v)
            az, el = ov.srp_phat_doa(phi_x, phi_v, fs, mic_pos)
            az_list.append(az); el_list.append(el)
        # Movement test that resists the circular array's front/back DOA
        # ambiguity (which makes a *static* talker's azimuth flip ±180° between
        # blocks). A genuine moving talker sweeps in ONE direction, so we require
        # both a wide unwrapped spread AND a consistent (monotonic) drift —
        # random sign-flipping deltas read as a static talker, not movement.
        # Defaulting to "static" (batch beam) matches the bootstrap evidence that
        # batch RTF-MVDR beats the tracked variant on most of these recordings.
        az_u = np.rad2deg(np.unwrap(np.deg2rad(az_list)))
        spread = abs(float(np.ptp(az_u)))
        deltas = np.diff(az_u)
        consistent = len(deltas) > 0 and (
            bool(np.all(deltas > 5.0)) or bool(np.all(deltas < -5.0)))
        moved = (spread > move_thresh_deg) and consistent
        return ({"ran": True, "az_per_block": [int(v) for v in az_list],
                 "el_per_block": [int(v) for v in el_list],
                 "az_spread_deg": round(spread, 1), "moved": bool(moved),
                 "n_blocks": int(n_blocks)}, moved)
    except Exception as e:
        return ({"ran": False, "reason": f"error: {e}"}, False)


# =========================================================================
#  [5b]  RTF-DRIFT TALKER-MOVEMENT DETECTOR  (alternative to SRP-PHAT)
# =========================================================================
def rtf_drift(y, fs, n_blocks=6, move_thresh=0.12, fmin=300.0, fmax=3400.0, ref=0):
    """Detect talker movement from how much the RTF *itself* changes block-to-block.

    The companion to :func:`track_doa`. Where ``track_doa`` estimates an azimuth
    per block and watches its spread, this estimates the relative transfer
    function (RTF) per block — the SAME quantity the MVDR beamformer steers with —
    and measures how far it drifts. The drift between two blocks is the mean over
    the speech band (``fmin``..``fmax``) of ``1 − |aᴴb| / (‖a‖‖b‖)`` per bin, i.e.
    one minus the normalized RTF similarity: 0 = identical acoustic path, →1 =
    fully changed.

    THE DECISION RULE (calibrated on this project's recordings). The very FIRST
    block-to-block transition is dropped: on every real clip it carries a
    one-time bump as the RTF estimate settles out of the onset/reverb build-up
    (and a single mid-clip reposition also shows up as one isolated bump). What
    distinguishes a genuinely *moving* talker is SUSTAINED drift — the RTF keeps
    changing block after block. So ``moved`` fires on the MEDIAN of the remaining
    "steady" transitions, which is robust to that single settling spike. Measured
    here: every static/real recording has a steady-median of ≤0.01 while a
    continuously sweeping source sits at ~0.30 — a wide margin, so ``move_thresh``
    defaults to 0.12.

    WHY this can beat SRP-PHAT here: the RTF carries no angle, so it has NONE of
    the circular-array front/back ±180° ambiguity that makes ``track_doa`` need a
    monotonic-drift guard (see its comment) to avoid false "moved" triggers on a
    *static* talker. RTF drift also measures exactly what makes the batch beam
    stale (a changed RTF), rather than a geometric proxy for it. The trade-off:
    it is unitless (no degree readout) and a loud non-speech event can also move
    the RTF — so it is offered ALONGSIDE ``track_doa`` (which still supplies the
    azimuth readout), not as a replacement.

    Mirrors ``track_doa``'s contract: returns ``(info, moved)`` and degrades to
    ``moved=False`` (cheap batch beam) on any failure.
    """
    from . import pipeline as ov
    try:
        D, n = y.shape
        if D < 2:
            return {"ran": False, "reason": "single channel"}, False
        X = ov.stft_multich(np.ascontiguousarray(y.T))   # (F, T, D)
        F, T, _ = X.shape
        n_blocks = max(2, min(n_blocks, T // 2))         # need ≥2 frames/block
        freqs = np.fft.rfftfreq(ov.NFFT, 1.0 / fs)
        band = (freqs >= fmin) & (freqs <= fmax)
        if band.sum() < 4:
            band = np.ones_like(freqs, dtype=bool)
        edges = np.linspace(0, T, n_blocks + 1).astype(int)
        rtfs = []
        for b in range(n_blocks):
            lo, hi = edges[b], max(edges[b] + 1, edges[b + 1])
            Xb = X[:, lo:hi, :]
            mask = ov.estimate_softmask(Xb)
            phi_x, phi_v = ov.compute_csm_masked(Xb, mask)
            phi_x = ov.regularise(phi_x)
            phi_v = ov.regularise(phi_v)
            rtfs.append(ov.estimate_rtf(phi_x, phi_v, ref=ref))   # (F, D)
        drifts = []
        for i in range(1, len(rtfs)):
            a = rtfs[i - 1][band]                          # (Fb, D)
            b2 = rtfs[i][band]
            num = np.abs(np.sum(a * np.conj(b2), axis=1))
            den = np.linalg.norm(a, axis=1) * np.linalg.norm(b2, axis=1) + EPS
            drifts.append(float(np.mean(1.0 - num / den)))
        # Drop the first transition (onset/settling) and judge SUSTAINED drift via
        # the median of the rest. With <2 steady transitions, fall back to the raw
        # drifts (short clip) and don't over-claim movement.
        steady = drifts[1:] if len(drifts) >= 2 else drifts
        steady_median = float(np.median(steady)) if steady else 0.0
        moved = steady_median >= move_thresh
        return {"ran": True, "n_blocks": int(n_blocks),
                "drift_per_step": [round(d, 3) for d in drifts],
                "steady_median": round(steady_median, 3),
                "max_drift": round(max(drifts) if drifts else 0.0, 3),
                "move_thresh": move_thresh, "moved": bool(moved)}, bool(moved)
    except Exception as e:
        return {"ran": False, "reason": f"error: {e}"}, False


# =========================================================================
#  [6·mask]  SPATIAL-COHERENCE (ASA) MASK + AUTO-SELECTING MVDR
# =========================================================================
def spatial_coherence(X, ref=0, fsmooth=2, tsmooth=3):
    """Per-bin inter-microphone coherence — the ASA "common spatial location" cue.

    The instrument's :func:`pipeline.estimate_softmask` collapses the array to a
    mono magnitude BEFORE masking, so it is blind to direction. This recovers the
    spatial information the mask threw away: for each non-reference channel it
    measures the magnitude-squared coherence with the reference over a small
    time-frequency neighbourhood, ``|⟨Xᵣ X_jᴴ⟩|² / (⟨|Xᵣ|²⟩⟨|X_j|²⟩)``, and
    averages over channels. A value near 1 means that T-F unit is dominated by a
    single directional source (speech); near 0 means diffuse energy (late reverb,
    fan/HVAC noise). ``X`` is ``(F, T, C)``; returns ``(F, T)`` in [0, 1].
    """
    F, T, C = X.shape

    def _smooth(A):
        k = np.ones((2 * fsmooth + 1, 2 * tsmooth + 1)) / ((2 * fsmooth + 1) * (2 * tsmooth + 1))
        return sps.fftconvolve(A, k, mode="same")

    Xr = X[:, :, ref]
    Srr = _smooth(np.abs(Xr) ** 2)
    coh = np.zeros((F, T), dtype=np.float64)
    cnt = 0
    for j in range(C):
        if j == ref:
            continue
        Sjj = _smooth(np.abs(X[:, :, j]) ** 2)
        Srj = _smooth(Xr * np.conj(X[:, :, j]))
        coh += np.clip((np.abs(Srj) ** 2) / (Srr * Sjj + EPS), 0.0, 1.0)
        cnt += 1
    return (coh / max(cnt, 1)).astype(np.float32)


def _mask_select_proxy(y, mask0, fs):
    """Reference-free quality proxy for AUTO mask selection: output speech/noise
    separation where the frames are labelled by the SNR MASK (not the input
    envelope the bootstrap uses, and not the output itself — so it is an
    INDEPENDENT judge). Higher = cleaner separation."""
    try:
        _, _, Z = sps.stft(y, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP, window=WIN, boundary=None)
        e = 10.0 * np.log10((np.abs(Z) ** 2).sum(0) + EPS)
        fr = mask0.sum(0)
        Tn = min(len(e), len(fr))
        e, fr = e[:Tn], fr[:Tn]
        hi = fr >= np.quantile(fr, 0.75)
        lo = fr <= np.quantile(fr, 0.25)
        if hi.sum() < 1 or lo.sum() < 1:
            return 0.0
        return float(e[hi].mean() - e[lo].mean())
    except Exception:
        return 0.0


def beamform_masked(y, sr, mask_mode="snr", blend=0.9):
    """Batch RTF-MVDR with a selectable speech/noise mask. Returns ``(mono, info)``.

    ``mask_mode``:
      · ``"snr"`` (baseline) — the instrument's energy soft-mask only.
      · ``"coherent"`` — fuse the spatial-coherence (ASA) cue into the mask, so the
        speech covariance is built from directional T-F units and diffuse
        reverb/noise is pushed into the noise covariance. Gentle blend
        (``M·(blend + (1−blend)·coherence)``) — measured best at blend≈0.9.
      · ``"auto"`` — compute BOTH beams and keep whichever scores higher on the
        independent :func:`_mask_select_proxy`. This is "never worse than
        baseline" by construction: across this project's recordings it kept the
        full mean +1.8 dB SNR gain of the coherent mask while cutting the
        worst-case regression from −2.8 dB to −0.5 dB.
    """
    from . import pipeline as ov
    D, n = y.shape
    if D == 1:
        return y[0].astype(np.float32), {"mask": mask_mode, "note": "single channel"}
    X = ov.stft_multich(np.ascontiguousarray(y.T))          # (F, T, D)
    M0 = ov.estimate_softmask(X)
    ref, _ = ov.pick_reference_channel(X, M0)

    def _beam(mask):
        phi_x, phi_v = ov.compute_csm_masked(X, mask)
        phi_x = ov.regularise(phi_x)
        phi_v = ov.regularise(phi_v)
        w = ov.bf_mvdr(ov.estimate_rtf(phi_x, phi_v, ref=ref), phi_v)
        return ov.istft_single(ov.apply_beamformer(X, w), n_out=n).astype(np.float32)

    if mask_mode == "snr":
        return _beam(M0), {"mask": "snr"}
    coh = spatial_coherence(X, ref=ref)
    Mc = np.clip(M0 * (blend + (1.0 - blend) * coh), 0.02, 0.98).astype(np.float32)
    if mask_mode == "coherent":
        return _beam(Mc), {"mask": "coherent", "blend": blend,
                           "mean_coherence": round(float((coh * M0).sum() / (M0.sum() + EPS)), 3)}
    # auto: build both, keep the one the independent proxy prefers
    y_snr, y_coh = _beam(M0), _beam(Mc)
    s_snr, s_coh = _mask_select_proxy(y_snr, M0, sr), _mask_select_proxy(y_coh, M0, sr)
    picked = "coherent" if s_coh > s_snr else "snr"
    return (y_coh if picked == "coherent" else y_snr), {
        "mask": "auto", "picked": picked, "blend": blend,
        "proxy_snr": round(s_snr, 2), "proxy_coherent": round(s_coh, 2)}


# =========================================================================
#  [6·who]  TARGET-SPEAKER SELECTION  — detect talkers, extract one by direction
# =========================================================================
#  A multi-talker recording on the 8-mic array carries each person at a
#  different DIRECTION (azimuth). These two functions turn that into a
#  "whose voice?" picker:
#    · detect_talker_directions() scans azimuth and returns the active talker
#      angles (peaks of a speech-weighted SRP-PHAT spatial spectrum), and
#    · extract_direction() steers a direction-masked RTF-MVDR at ONE chosen
#      azimuth — the target's direction builds the speech covariance, every
#      other direction (the other talkers + diffuse noise) builds the noise
#      covariance, so the beam keeps the chosen person and nulls the rest.
#  Both reuse the instrument's covariance / RTF / MVDR primitives wholesale.
#
#  Geometry note: people seated around a table are ~in-plane, so detection and
#  extraction fix elevation at 0° and scan azimuth only (the small UCA resolves
#  azimuth far better than elevation). The UCA's front/back ±180° ambiguity
#  (see track_doa) means a front/back MIRROR pair of talkers can share an
#  apparent angle — fine for people on one side of the array, ambiguous when
#  they fully surround it.
# =========================================================================
def _az_unit(az_deg, el_deg=0.0):
    """Unit propagation direction for an (azimuth, elevation) in degrees."""
    az, el = np.deg2rad(az_deg), np.deg2rad(el_deg)
    return np.array([np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)])


def _directional_response(X, sv, band):
    """Per-TF coherent power of the array toward a steering vector, PHAT-weighted.

    ``X`` is ``(F,T,D)``; ``sv`` is ``(F,D)`` (unit-magnitude plane-wave steering);
    ``band`` is a boolean ``(F,)`` speech-band mask. Returns ``align (F,T)`` in
    [0,1] — how strongly each time-frequency unit looks like a single source from
    the steered direction (1 = perfectly aligned, 0 = diffuse / other direction).
    PHAT normalization (divide by |X|) makes it amplitude-blind, so a loud bin
    from another talker doesn't dominate the geometry test.
    """
    Xp = X / (np.abs(X) + EPS)                          # (F,T,D) PHAT-whitened
    # coherent sum over mics: Σ_d conj(sv) · Xp  → (F,T)
    num = np.abs(np.einsum("fd,ftd->ft", np.conj(sv), Xp)) ** 2
    align = num / (X.shape[2] ** 2)                     # |sv|=1 ⇒ max = D²
    align = np.clip(align, 0.0, 1.0).astype(np.float32)
    align[~band, :] = 0.0
    return align


def detect_talker_directions(y, fs, mic_pos, az_step=5.0, n_max=4,
                             min_sep_deg=25.0, rel_thresh=0.45,
                             min_activity=0.04, fmin=200.0, fmax=4000.0):
    """Auto-detect the active talker directions on the array.

    Builds a speech-weighted SRP-PHAT *azimuth spectrum* — for every candidate
    angle, the speech-band coherent power steered that way, summed over the speech
    time-frequency units (Silero/energy soft-mask weighted) — then peak-picks it
    into a short list of talker directions. Each speaker is the centre of a
    spatial-spectrum peak that clears ``rel_thresh`` of the global max and sits at
    least ``min_sep_deg`` from a stronger peak.

    ``y`` is ``(D, samples)``. Returns a dict:
    ``{ran, speakers:[{az, strength, activity}], spectrum:{az:[…], power:[…]}}``
    where ``strength`` is the peak's normalized height (1 = the strongest talker)
    and ``activity`` is the fraction of speech frames that direction dominates.
    Degrades to ``{ran:False}`` on single-channel input or any failure.
    """
    _empty = {"ran": False, "n_speakers": 0, "speakers": [],
               "spectrum": {"az": [], "power": []}}
    from . import pipeline as ov
    try:
        D, n = y.shape
        if D < 2:
            return {**_empty, "reason": "single channel — no spatial info"}
        X = ov.stft_multich(np.ascontiguousarray(y.T))     # (F,T,D)
        F, T, _ = X.shape
        soft = ov.estimate_softmask(X)                      # (F,T) speech weight
        freqs = np.fft.rfftfreq(ov.NFFT, 1.0 / fs)
        band = (freqs >= fmin) & (freqs <= fmax)
        if band.sum() < 4:
            band = np.ones_like(freqs, dtype=bool)
        az_grid = np.arange(-180.0, 180.0, az_step)
        # Spatial spectrum P(az) = Σ_TF speech_weight · directional_response(az),
        # plus a per-frame winner tally so we can report each talker's "activity".
        P = np.zeros(len(az_grid), dtype=np.float64)
        frame_resp = np.empty((len(az_grid), T), dtype=np.float32)
        for i, az in enumerate(az_grid):
            sv = ov.steering_vector(_az_unit(az), fs, ov.NFFT, mic_pos)   # (F,D)
            align = _directional_response(X, sv, band)      # (F,T)
            wresp = align * soft                            # weight by speech
            frame_resp[i] = wresp.sum(axis=0)
            P[i] = float(wresp.sum())
        if P.max() <= EPS:
            return {**_empty, "reason": "no directional speech energy"}
        # Circular-smooth the azimuth spectrum (it wraps at ±180) to suppress the
        # jagged sidelobes a small array produces, then re-normalize.
        ksm = 3
        Ps = np.array([P[(np.arange(i - ksm, i + ksm + 1)) % len(P)].mean()
                       for i in range(len(P))])
        Pn = Ps / Ps.max()
        # Per-frame dominant azimuth → activity share per candidate angle.
        winner = frame_resp.argmax(axis=0)                  # (T,) az-index per frame
        speech_fr = soft.sum(axis=0) >= np.quantile(soft.sum(axis=0), 0.5)
        # Peak-pick Pn: strict LOCAL maxima ≥ rel_thresh, greedily enforce a
        # minimum angular separation (circular). A candidate must also clear a
        # minimum speech-frame ACTIVITY so spatial sidelobes (high spectrum power
        # but never the per-frame winner) are rejected — only directions a talker
        # actually dominates for part of the clip survive.
        # Greedy by descending spectrum power: the strongest angle is taken first,
        # then every angle within ``min_sep_deg`` of an already-chosen one is
        # skipped (so one peak yields one talker — this de-duplicates without a
        # separate local-max test). A candidate must also clear ``rel_thresh`` of
        # the global max AND a minimum speech-frame ACTIVITY, which rejects spatial
        # sidelobes (high spectrum power but never the per-frame winner).
        order = np.argsort(Pn)[::-1]
        chosen = []
        for idx in order:
            if Pn[idx] < rel_thresh:
                break
            az = az_grid[idx]
            if any(abs((az - az_grid[c] + 180) % 360 - 180) < min_sep_deg for c in chosen):
                continue
            ang = np.abs((az_grid[winner] - az + 180) % 360 - 180)
            act = float(((ang <= min_sep_deg / 2.0) & speech_fr).sum() / max(speech_fr.sum(), 1))
            if act < min_activity:
                continue                                    # sidelobe, not a talker
            chosen.append(idx)
            if len(chosen) >= n_max:
                break
        chosen.sort(key=lambda c: az_grid[c])
        speakers = []
        for c in chosen:
            ang = np.abs((az_grid[winner] - az_grid[c] + 180) % 360 - 180)
            act = float(((ang <= min_sep_deg / 2.0) & speech_fr).sum() / max(speech_fr.sum(), 1))
            speakers.append({"az": int(round(az_grid[c])),
                             "strength": round(float(Pn[c]), 3),
                             "activity": round(act, 3)})
        return {"ran": True, "n_speakers": len(speakers), "speakers": speakers,
                "spectrum": {"az": [int(a) for a in az_grid],
                             "power": [round(float(v), 4) for v in Pn]}}
    except Exception as e:
        return {**_empty, "reason": f"error: {e}"}


def extract_direction(y, fs, mic_pos, az_deg, el_deg=0.0, interferer_az=(),
                      sharp=3.0, postmask_db=-18.0, smooth=(3, 3)):
    """Extract the talker at one azimuth with a direction-masked RTF-MVDR.

    Steers the array at ``az_deg`` (elevation ``el_deg``, default in-plane) and
    builds the speech covariance from the time-frequency units whose spatial
    signature MATCHES that direction, while EVERY OTHER direction — the other
    talkers and diffuse noise — falls into the noise covariance ``(1 − mask)``.
    The resulting RTF-MVDR keeps the chosen person and nulls the rest. Reuses
    ``compute_csm_masked`` / ``estimate_rtf`` / ``bf_mvdr`` / ``apply_beamformer``
    so it is the same validated math as the batch beam, only the MASK is
    direction-defined instead of energy-defined.

    ``interferer_az`` — the OTHER detected talker azimuths. When supplied the mask
    is COMPETITIVE: a T-F unit is assigned to the target only when the target
    direction beats every interferer there, ``align_tgt / (align_tgt + Σ
    align_interf)``. This is what isolates a talker flanked by others — a small
    array has poor low-frequency angular resolution, so an *absolute* directional
    mask leaks the neighbours' low-band energy; the competitive ratio removes it.

    ``y`` is ``(D, samples)``; returns the extracted mono ``(samples,)`` float32.
    Falls back to the array downmix on any failure (never silent).
    """
    from . import pipeline as ov
    D, n = y.shape
    if D == 1:
        return y[0].astype(np.float32)
    try:
        X = ov.stft_multich(np.ascontiguousarray(y.T))     # (F,T,D)
        freqs = np.fft.rfftfreq(ov.NFFT, 1.0 / fs)
        band = (freqs >= 150.0) & (freqs <= 6000.0)
        if band.sum() < 4:
            band = np.ones_like(freqs, dtype=bool)
        sv = ov.steering_vector(_az_unit(az_deg, el_deg), fs, ov.NFFT, mic_pos)
        align_t = _directional_response(X, sv, band) ** sharp     # (F,T)
        soft = ov.estimate_softmask(X)                            # (F,T) speech weight
        # Competitive directional mask: target share of the aligned energy among
        # {target} ∪ {interferers}. With no interferers it degrades to the plain
        # sharpened directional mask (denominator = target alone + ε).
        denom = align_t.copy()
        for iaz in interferer_az:
            if abs((float(iaz) - az_deg + 180) % 360 - 180) < 1.0:
                continue                                          # skip self
            svi = ov.steering_vector(_az_unit(float(iaz), el_deg), fs, ov.NFFT, mic_pos)
            denom = denom + _directional_response(X, svi, band) ** sharp
        share = align_t / (denom + EPS)                           # (F,T) in [0,1]
        # Target mask: speech AND target-dominant direction. Clip away from {0,1}
        # so both covariances are well-conditioned (1−mask is the noise weight).
        M = np.clip(soft * share, 0.02, 0.98).astype(np.float32)
        ref, _ = ov.pick_reference_channel(X, M)
        phi_x, phi_v = ov.compute_csm_masked(X, M)
        phi_x = ov.regularise(phi_x)
        phi_v = ov.regularise(phi_v)
        rtf = ov.estimate_rtf(phi_x, phi_v, ref=ref)
        w = ov.bf_mvdr(rtf, phi_v)
        beam = ov.apply_beamformer(X, w)                          # (F,T) spectrum
        # Directional POST-FILTER. A small array nulls poorly at low frequencies
        # (especially with interferers on opposite sides), so the spatial null
        # alone can't fully isolate a flanked talker. Multiplying the beam by the
        # competitive target share — floored at ``postmask_db`` to cap musical
        # noise, lightly smoothed in freq×time — adds the missing rejection; the
        # downstream DFN3 then cleans any residual warble. Set postmask_db=None
        # to disable (pure spatial beam).
        if postmask_db is not None:
            gfloor = 10.0 ** (postmask_db / 20.0)
            G = np.clip(share, gfloor, 1.0).astype(np.float32)
            sf, st = smooth
            if sf and sf > 1:
                G = sps.fftconvolve(G, np.ones((sf, 1), np.float32) / sf, mode="same", axes=0)
            if st and st > 1:
                G = sps.fftconvolve(G, np.ones((1, st), np.float32) / st, mode="same", axes=1)
            beam = beam * G
        out = ov.istft_single(beam, n_out=n).astype(np.float32)
        if out.size == 0 or not np.all(np.isfinite(out)):
            raise ValueError("empty/non-finite extraction")
        return out
    except Exception as e:
        print(f"[WARN] extract_direction({az_deg}°) failed: {e}")
        return y.mean(axis=0)[:n].astype(np.float32)


# =========================================================================
#  [7]  AEC — frequency-domain NLMS with a far-end reference
# =========================================================================
def aec_nlms(mic, far_ref, fs, mu=0.3, leak=0.999):
    """Cancel the far-end loudspeaker echo from ``mic`` using ``far_ref``.

    A per-bin normalized LMS in the STFT domain: each frequency bin runs a
    single-tap complex adaptive filter ``w`` that predicts the echo in the mic
    from the reference, updated frame-to-frame with a normalized step. This is a
    deliberately compact, stable AEC — enough to demonstrate the stage on a real
    reference, not a full multi-tap partitioned canceller.

    DESIGN: when ``far_ref is None`` (the OCTOVOX files carry only mic capsules,
    no loudspeaker feed) this is a clean PASS-THROUGH — it never fabricates
    cancellation. Supply a reference WAV to activate it. Returns ``(out, info)``.
    """
    if far_ref is None:
        return mic, {"ran": False, "reason": "no far-end reference supplied (pass-through)"}
    try:
        m = np.asarray(mic, dtype=np.float32).reshape(-1)
        r = np.asarray(far_ref, dtype=np.float32).reshape(-1)
        L = min(len(m), len(r))
        if L < NFFT:
            return mic, {"ran": False, "reason": "reference too short"}
        m, r = m[:L], r[:L]
        _, _, M = sps.stft(m, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP, window=WIN, boundary=None)
        _, _, R = sps.stft(r, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP, window=WIN, boundary=None)
        Tn = min(M.shape[1], R.shape[1])
        M, R = M[:, :Tn], R[:, :Tn]
        F = M.shape[0]
        w = np.zeros(F, dtype=np.complex128)
        E = np.empty_like(M)
        rpow = np.zeros(F)
        for t in range(Tn):
            rt = R[:, t]
            yhat = w * rt                                    # predicted echo
            e = M[:, t] - yhat
            E[:, t] = e
            rpow = leak * rpow + (1.0 - leak) * (np.abs(rt) ** 2)
            w = leak * w + mu * np.conj(rt) * e / (rpow + EPS)
        _, out = sps.istft(E, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP, window=WIN, boundary=None)
        if len(out) < len(mic):
            out = np.pad(out, (0, len(mic) - len(out)))
        erle = 10.0 * np.log10((np.mean(np.abs(M) ** 2) + EPS) / (np.mean(np.abs(E) ** 2) + EPS))
        return out[:len(mic)].astype(np.float32), {"ran": True, "erle_db": round(float(erle), 1), "mu": mu}
    except Exception as e:
        return mic, {"ran": False, "reason": f"error: {e}"}


def aec_partitioned(mic, far_ref, fs, n_taps=8, mu=0.3, leak=0.999):
    """Multi-tap (partitioned) STFT-domain AEC — models a long echo tail.

    The single-tap :func:`aec_nlms` only cancels echo that fits inside one STFT
    frame (~21 ms here); real room echo decays over hundreds of ms. This filter
    keeps one complex weight per (bin, tap) and predicts the mic echo from the
    last ``n_taps`` reference frames — a frequency-domain partitioned block
    adaptive filter, the WebRTC-AEC3 family the senior repo's
    ``PartitionedBlockAEC`` approximates — so it cancels tails up to roughly
    ``n_taps × HOP`` samples (≈ ``n_taps`` × 5.3 ms). Weights use the same
    normalized, leaky update as :func:`aec_nlms` with magnitude clipping for
    stability.

    DESIGN: identical contract to :func:`aec_nlms` — clean PASS-THROUGH when
    ``far_ref is None`` (the OCTOVOX files carry only mic capsules), so it never
    fabricates cancellation. Returns ``(out, info)``; never raises.
    """
    if far_ref is None:
        return mic, {"ran": False, "reason": "no far-end reference supplied (pass-through)"}
    try:
        m = np.asarray(mic, dtype=np.float32).reshape(-1)
        r = np.asarray(far_ref, dtype=np.float32).reshape(-1)
        L = min(len(m), len(r))
        if L < NFFT:
            return mic, {"ran": False, "reason": "reference too short"}
        m, r = m[:L], r[:L]
        _, _, M = sps.stft(m, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP, window=WIN, boundary=None)
        _, _, R = sps.stft(r, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP, window=WIN, boundary=None)
        Tn = min(M.shape[1], R.shape[1])
        M, R = M[:, :Tn], R[:, :Tn]
        F = M.shape[0]
        K = max(1, int(n_taps))
        W = np.zeros((F, K), dtype=np.complex128)         # per-bin, per-tap weights
        E = np.empty_like(M)
        for t in range(Tn):
            yhat = np.zeros(F, dtype=np.complex128)
            denom = np.full(F, EPS)                         # total tap-window power
            for k in range(K):                             # sum echo over past frames
                tk = t - k
                if tk >= 0:
                    yhat += W[:, k] * R[:, tk]
                    denom = denom + np.abs(R[:, tk]) ** 2
            e = M[:, t] - yhat
            E[:, t] = e
            # NLMS step normalized by the power across ALL taps (not one frame),
            # so adding taps does not multiply the effective step into divergence.
            step = mu * e / denom
            for k in range(K):
                tk = t - k
                if tk >= 0:
                    W[:, k] = leak * W[:, k] + step * np.conj(R[:, tk])
            np.clip(W.real, -10, 10, out=W.real)
            np.clip(W.imag, -10, 10, out=W.imag)
        _, out = sps.istft(E, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP, window=WIN, boundary=None)
        if len(out) < len(mic):
            out = np.pad(out, (0, len(mic) - len(out)))
        erle = 10.0 * np.log10((np.mean(np.abs(M) ** 2) + EPS) / (np.mean(np.abs(E) ** 2) + EPS))
        return out[:len(mic)].astype(np.float32), {"ran": True, "erle_db": round(float(erle), 1),
                                                   "n_taps": K, "mu": mu, "engine": "partitioned"}
    except Exception as e:
        return mic, {"ran": False, "reason": f"error: {e}"}


# =========================================================================
#  [7b]  FEEDBACK / HOWLING RISK  (read-only diagnostic on the beam)
# =========================================================================
def feedback_risk(mono, fs, peak_ratio_thresh=10.0, dominance_thresh=5000.0,
                  min_sustain_s=0.30, high_sustain_s=0.50, min_hz=200.0):
    """Diagnostic: flag a sustained, spectrally-dominant pure tone — the
    signature of acoustic feedback (PA howl) — in the beamformed mono.

    Ported in spirit from the senior repo's ``HybridAFC._detect_howling`` but
    recalibrated against real OCTOVOX recordings, because the naive "peaky bin"
    test false-fires on normal speech (voiced harmonics are spiky and the MVDR
    beam steadies them for ~0.5 s). Two features are measured over the longest
    run where one bin (peakiness = max ÷ median ≥ ``peak_ratio_thresh``) stays
    the dominant spectral peak (±1 bin of drift):

      · ``sustain_s``  — how long that bin stays locked, and
      · ``dominance``  — the mean peakiness over the run (how far the tone towers
        over the rest of the spectrum).

    On the available clean recordings a steadied voiced tone reaches ~0.5 s but
    its dominance tops out near ~1300; a runaway howl towers ~10⁴–10⁷ over the
    median. So risk fires only when BOTH a long sustain AND a high dominance hold
    — keeping the diagnostic quiet on normal speech.

    Calibration note: thresholds were set from the project's clean recordings
    (no ground-truth feedback capture was available), so this is deliberately
    CONSERVATIVE — it flags a fully-developed howl, and may not catch a nascent
    one. The descriptors are always reported (even at ``low``) so the raw numbers
    are inspectable. READ-ONLY — on an offline file there is no PA loop to break,
    so it only REPORTS. Never raises.
    """
    try:
        x = np.asarray(mono, dtype=np.float32).reshape(-1)
        if len(x) < NFFT:
            return {"ran": False, "reason": "signal too short"}
        f, _, Z = sps.stft(x, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP, window=WIN, boundary=None)
        band = f >= min_hz                                # skip rumble / voice fundamental
        if band.sum() < 4:
            band = np.ones_like(f, dtype=bool)
        f = f[band]
        mag = np.abs(Z)[band, :]                           # (F', T)
        peakiness = mag.max(axis=0) / (np.median(mag, axis=0) + EPS)
        peak_bin = mag.argmax(axis=0)
        hot = peakiness >= peak_ratio_thresh               # frame has a clear tone
        # Longest consecutive run where ONE bin stays the hot dominant peak.
        best_run, best_bin, best_end = 0, None, 0
        cur_run, anchor = 0, -99
        for i in range(len(peak_bin)):
            if hot[i] and abs(int(peak_bin[i]) - anchor) <= 1:
                cur_run += 1
            elif hot[i]:
                anchor, cur_run = int(peak_bin[i]), 1      # start a new run on this bin
            else:
                cur_run, anchor = 0, -99
            if cur_run > best_run:
                best_run, best_bin, best_end = cur_run, anchor, i
        run_s = best_run / (fs / HOP)
        # Dominance = how far the locked tone towers over the spectrum, averaged
        # over the run (this is what separates a howl from steadied speech).
        if best_run > 0:
            seg = peakiness[best_end - best_run + 1: best_end + 1]
            dominance = float(np.mean(seg))
        else:
            dominance = 0.0
        strong = dominance >= dominance_thresh
        if strong and run_s >= high_sustain_s:
            risk = "high"
        elif strong and run_s >= min_sustain_s:
            risk = "elevated"
        else:
            risk = "low"
        info = {"ran": True, "risk": risk,
                "risk_score": round(float(min(1.0, (run_s / max(high_sustain_s, 1e-6))
                                              * min(1.0, dominance / max(dominance_thresh, 1e-6)))), 2),
                "sustain_s": round(float(run_s), 3),
                "dominance": round(dominance, 1)}
        if best_bin is not None:
            info["suspect_hz"] = round(float(f[best_bin]), 1)
        return info
    except Exception as e:
        return {"ran": False, "reason": f"error: {e}"}


# =========================================================================
#  [9]  AUTOMIX / GATING / BEAM WEIGHTING
# =========================================================================
def automix(mono, fs, floor_db=-24.0):
    """Single-beam automix = speech-protective gating on the one active beam.

    A classic automixer shares gain across many open mics so only the talker's
    channel is up; with a single steered beam this reduces to gating that beam —
    hold it open on speech, gently duck it into the gaps — which is exactly the
    cascade's validated ``_vad_silence_floor`` (hysteresis + hangover + slow
    release, so words are never clipped). Returns ``(out, info)``."""
    out, info = _vad_silence_floor(mono, fs, floor_db=floor_db)
    info = dict(info)
    info["role"] = "automix / gating (single-beam)"
    return out, info


# =========================================================================
#  [10]  EQ — gentle speech-presence shaping (RBJ biquads)
# =========================================================================
def _biquad_peaking(f0, gain_db, q, fs):
    """One RBJ peaking-EQ biquad → (b, a)."""
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * f0 / fs
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2.0 * q)
    b = np.array([1 + alpha * A, -2 * cw, 1 - alpha * A])
    a = np.array([1 + alpha / A, -2 * cw, 1 - alpha / A])
    return b / a[0], a / a[0]


def apply_eq(x, fs):
    """Gentle, fixed broadcast-style speech EQ: trim low-mid 'mud', lift the
    presence band for intelligibility, and a soft air shelf. Deliberately SUBTLE
    and BROAD (low gains, wide Q) so it clarifies without adding the harsh,
    'robotic' edge that a narrow presence boost produces. Never raises."""
    bands = [(300.0, -1.5, 0.7),    # cut boxy low-mid mud (broad)
             (2600.0, +1.5, 0.7),   # gentle presence / intelligibility (broad)
             (8000.0, +1.0, 0.7)]   # a touch of air
    try:
        y = np.asarray(x, dtype=np.float64).reshape(-1)
        for f0, g_db, q in bands:
            if f0 < 0.45 * fs:
                b, a = _biquad_peaking(f0, g_db, q, fs)
                y = sps.lfilter(b, a, y)
        return y.astype(np.float32), {"ran": True,
                                      "bands": [{"f": f0, "gain_db": g} for f0, g, _ in bands]}
    except Exception as e:
        return np.asarray(x, dtype=np.float32), {"ran": False, "reason": f"error: {e}"}


# =========================================================================
#  [10b]  PERCEPTUAL AGC — loudness smoothing with attack/release + K-weight
# =========================================================================
def perceptual_agc(x, fs, target_dbfs=-23.0, attack_ms=20.0, release_ms=500.0,
                   max_gain_db=24.0, block_ms=10.0, hp_hz=100.0, active_pct=70.0):
    """Loudness-riding AGC with fast-attack / slow-release + K-weighting.

    Ported from the senior repo's ``PerceptualAGC``. The instrument's
    :func:`pipeline.agc_to_dbfs` applies ONE instantaneous RMS gain to the whole
    clip; this instead rides the speech envelope so quiet passages come up and
    loud ones are held back, without pumping:

      1. K-weight the signal (a ~100 Hz high-pass, the ITU-R BS.1770 pre-filter
         approximation) so loudness is measured the way it's *perceived*.
      2. Per 10 ms block, smooth the loudness with fast attack / slow release
         time constants — gain reacts quickly to onsets, releases gently.
      3. Target gain = ``sqrt(target_power / smoothed_power)``, clamped to
         ``max_gain_db`` so silence is never boosted into a wall of noise.
      4. Linearly interpolate gain across each block (no zipper artifacts) and
         apply to the ORIGINAL signal (the K-weighting is measurement-only).

    STARTUP: the loudness and gain are SEEDED at the clip's steady-state *active*
    level (the mean energy of the loud ``active_pct`` blocks), not at the first
    block. A clip almost always opens on silence or a breath; seeding from that
    first block would start ``smoothed`` near zero, slam the gain to the ceiling,
    and *blast the first word* before the release pulls it down. Because this is
    offline we can see the whole clip, so the gain instead begins exactly where
    it will settle — no startup transient. Returns ``(y, info)``; never raises.
    """
    try:
        x = np.asarray(x, dtype=np.float32).reshape(-1)
        n = len(x)
        if n == 0:
            return x, {"ran": False, "reason": "empty signal"}
        sos = sps.butter(2, hp_hz, btype="highpass", fs=fs, output="sos")
        xk = sps.sosfilt(sos, x).astype(np.float64)        # K-weighted (measurement only)
        block = max(1, int(block_ms * 1e-3 * fs))
        n_blocks = (n + block - 1) // block
        # Per-block K-weighted power (reused for seeding and the gain loop).
        be = np.empty(n_blocks)
        for b in range(n_blocks):
            s, e = b * block, min((b + 1) * block, n)
            be[b] = float(np.mean(xk[s:e] ** 2)) + EPS
        # per-block time constants (block-rate, not sample-rate)
        a_att = np.exp(-1.0 / max(attack_ms * 1e-3 * fs / block, 1.0))
        a_rel = np.exp(-1.0 / max(release_ms * 1e-3 * fs / block, 1.0))
        target_pow = 10.0 ** (target_dbfs / 10.0)          # √(power) → RMS target
        max_gain = 10.0 ** (max_gain_db / 20.0)
        # Seed at the steady-state ACTIVE loudness so there is no startup blast.
        thr = np.percentile(be, active_pct)
        active = be[be >= thr]
        seed = max(float(np.mean(active)) if active.size else float(np.mean(be)), EPS)
        smoothed = seed
        init_gain = float(min(np.sqrt(target_pow / seed), max_gain))
        cur_gain = prev_g = init_gain
        gain_curve = np.ones(n, dtype=np.float32)
        for b in range(n_blocks):
            s, e = b * block, min((b + 1) * block, n)
            loud = be[b]
            a = a_att if loud > smoothed else a_rel
            smoothed = a * smoothed + (1.0 - a) * loud
            required = min(np.sqrt(target_pow / (smoothed + EPS)), max_gain)
            cur_gain = 0.9 * cur_gain + 0.1 * required      # extra inertia (senior's recipe)
            gain_curve[s:e] = np.linspace(prev_g, cur_gain, e - s, dtype=np.float32)
            prev_g = cur_gain
        y = (x * gain_curve).astype(np.float32)
        return y, {"ran": True, "engine": "perceptual", "target_dbfs": target_dbfs,
                   "attack_ms": attack_ms, "release_ms": release_ms,
                   "max_gain_db": max_gain_db,
                   "init_gain_db": round(20.0 * np.log10(init_gain + EPS), 1),
                   "final_gain_db": round(20.0 * np.log10(cur_gain + EPS), 1)}
    except Exception as e:
        return np.asarray(x, dtype=np.float32), {"ran": False, "reason": f"error: {e}"}


# =========================================================================
#  FAST SPECTRAL DEREVERB — single-channel late-reverberation suppression
# =========================================================================
def dereverb_spectral(x, fs, t60=0.5, beta=1.6, gmin_db=-10.0,
                      early_ms=48.0, smooth_bins=3):
    """Fast single-channel dereverberation — statistical late-reverb suppression.

    The multichannel WPE front-end (:func:`pipeline.wpe_dereverberate`) is the
    gold standard but runs ~3× real-time and overshoots; on this hardware it is
    the single slowest stage. This is the fast alternative that runs on the
    *beamformed mono*: ~0.02× real-time, no matrix solves, and on these
    recordings it removes 2–4× more of the reverb tail than WPE does.

    Model (Lebart 2001 / Habets): the LATE reverberation is the early signal
    convolved with an exponentially-decaying tail set by the room ``t60``. We
    estimate the late-reverb power spectrum as a delayed, T60-decayed, recursively
    smoothed copy of the observed power:

        Pₗₐₜₑ(f,t) = onepole_a( P(f, t − d) ),  a = exp(−ln(10⁶)·HOP / (t60·fs))

    where ``d`` (``early_ms``) is the early-reflection boundary kept intact, then
    apply a spectral-subtraction gain ``G = max(1 − β·Pₗₐₜₑ/P, gmin)`` and resynth.

    ROBUST EDGES: scipy's ``istft`` with ``boundary=None`` divides by a near-zero
    window-sum on the under-overlapped first/last frame, which detonates into a
    multi-hundred-× spike there (the same latent bug as the old ``dd_wiener``).
    We analyse with ``boundary='zeros'`` (padded, well-conditioned edges) and
    clamp the result to the input envelope — dereverb only REMOVES energy, so the
    interior is bounded by the input and any residual edge artifact is clipped.

    Returns the dereverbed mono (same length); never raises (returns input on error).
    """
    try:
        x = np.asarray(x, dtype=np.float32).reshape(-1)
        if len(x) < NFFT:
            return x
        kw = dict(fs=fs, nperseg=NFFT, noverlap=NFFT - HOP, window=WIN)
        _, _, Z = sps.stft(x, boundary="zeros", padded=True, **kw)
        P = np.abs(Z) ** 2
        mag = np.abs(Z); ph = np.angle(Z)
        a = float(np.exp(-13.8155 * HOP / (t60 * fs)))      # per-frame 60 dB decay pole
        d = max(1, int(early_ms / 1000.0 * fs / HOP))        # early-reflection boundary (frames)
        Pd = np.zeros_like(P)
        if P.shape[1] > d:
            Pd[:, d:] = P[:, :-d]                            # delay past the early reflections
        R = sps.lfilter([1.0 - a], [1.0, -a], Pd, axis=1)    # one-pole IIR → late-reverb PSD
        G = np.maximum(1.0 - beta * R / (P + EPS), 10.0 ** (gmin_db / 20.0))
        if smooth_bins and smooth_bins > 1:                  # light spectral smoothing
            k = np.ones(smooth_bins, dtype=np.float32) / smooth_bins
            G = np.apply_along_axis(lambda c: np.convolve(c, k, mode="same"), 0, G)
        _, o = sps.istft(G * mag * np.exp(1j * ph), boundary=True, **kw)
        if len(o) < len(x):
            o = np.pad(o, (0, len(x) - len(o)))
        peak = float(np.max(np.abs(x)) + EPS)
        return np.clip(o[:len(x)], -peak, peak).astype(np.float32)   # envelope guard
    except Exception as e:
        print(f"[WARN] dereverb_spectral failed: {e}")
        return np.asarray(x, dtype=np.float32)


# =========================================================================
#  FAST SPECTRAL NR — decision-directed (low musical-noise / non-robotic)
# =========================================================================
def dd_wiener(x, fs, alpha=0.985, floor_db=-9.0, noise_pct=12.0, smooth_bins=3):
    """Decision-directed Wiener noise reduction — the fast, *natural-sounding*
    denoiser (the default ``wiener_post`` gates each bin independently, which
    produces the warbling 'musical noise' that sounds robotic).

    The cure is Ephraim–Malah decision-direction: the a-priori SNR ξ is smoothed
    recursively across time (ξ ← α·prev_clean/noise + (1−α)·max(γ−1,0), α≈0.985),
    so the gain can't flicker bin-to-bin frame-to-frame. A mild gain floor keeps a
    natural noise bed instead of pumping to digital silence, and a 3-bin spectral
    smoothing removes isolated tonal artifacts. Vectorized over frequency (loops
    only over time frames), so it stays fast. Never raises — returns input on error.
    """
    try:
        x = np.asarray(x, dtype=np.float32).reshape(-1)
        # boundary='zeros' (padded) so the under-overlapped edge frame is well
        # conditioned — boundary=None makes istft divide by a ~0 window-sum there
        # and detonate the first frame into a multi-hundred-× spike.
        f, t, Z = sps.stft(x, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP,
                           window=WIN, boundary="zeros", padded=True)
        mag = np.abs(Z); ph = np.angle(Z)
        P = mag ** 2
        F, T = P.shape
        # noise PSD from the quietest frames (per-bin)
        frame_e = P.mean(axis=0)
        thr = np.percentile(frame_e, noise_pct)
        quiet = frame_e <= max(thr, EPS)
        if quiet.sum() < 3:
            noise = np.percentile(P, noise_pct, axis=1, keepdims=True)
        else:
            noise = P[:, quiet].mean(axis=1, keepdims=True)
        noise = np.maximum(noise, EPS)
        gfloor = 10.0 ** (floor_db / 20.0)            # amplitude gain floor
        xi_floor = 10.0 ** (floor_db / 10.0)          # power a-priori-SNR floor
        gamma = P / noise                              # a-posteriori SNR (F,T)
        G = np.empty_like(P)
        prev_clean = np.maximum(P[:, 0] - noise[:, 0], 0.0)
        for nft in range(T):
            gpost = gamma[:, nft]
            if nft == 0:
                xi = np.maximum(gpost - 1.0, 0.0)
            else:
                xi = alpha * (prev_clean / noise[:, 0]) + (1.0 - alpha) * np.maximum(gpost - 1.0, 0.0)
            xi = np.maximum(xi, xi_floor)
            g = xi / (1.0 + xi)                        # Wiener gain from smoothed ξ
            g = np.maximum(g, gfloor)
            G[:, nft] = g
            prev_clean = (g * mag[:, nft]) ** 2        # feed back the clean estimate
        if smooth_bins and smooth_bins > 1:            # light spectral smoothing
            k = np.ones(smooth_bins, dtype=np.float32) / smooth_bins
            G = np.apply_along_axis(lambda c: np.convolve(c, k, mode="same"), 0, G)
        Zc = G * mag * np.exp(1j * ph)
        _, y = sps.istft(Zc, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP,
                         window=WIN, boundary=True)
        if len(y) < len(x):
            y = np.pad(y, (0, len(x) - len(y)))
        # NR only attenuates, so the output is bounded by the input envelope;
        # clamp to it as a guard against any residual edge artifact.
        peak = float(np.max(np.abs(x)) + EPS)
        return np.clip(y[:len(x)], -peak, peak).astype(np.float32)
    except Exception as e:
        print(f"[WARN] dd_wiener failed: {e}")
        return np.asarray(x, dtype=np.float32)


def residual_suppress(x, fs, strength=0.6, noise_pct=10.0,
                      smooth_bins=3, smooth_frames=3):
    """Residual stationary-noise suppressor — a gentle SECOND pass that runs
    *after* the main NR (DeepFilterNet3) to mop up the low stationary noise bed
    a naturalness-capped denoiser deliberately leaves behind.

    DFN3 is excellent on non-stationary noise but, with its attenuation capped
    for natural voice, it leaves a quiet steady hiss/hum. That residual is, by
    then, very stationary — so a per-bin noise PSD taken from the quietest frames
    (min-statistics style) models it well, and an over-subtraction Wiener gain
    removes it. ``strength`` in [0,1] dials aggressiveness::

        alpha (over-subtraction) = 1.0 + 1.6*strength    #  1.0 .. 2.6
        gmin  (spectral floor)   = -16 - 16*strength dB  # -16 .. -32 dB

    The gain is smoothed across frequency AND time so the suppression can't
    flicker bin-to-bin (that flicker is exactly the warbling 'musical noise').
    Edge-spike-safe (boundary='zeros'/True, see :func:`dd_wiener`) and clamped to
    the input envelope. Never raises — returns the input unchanged on error.
    """
    try:
        x = np.asarray(x, dtype=np.float32).reshape(-1)
        s = float(np.clip(strength, 0.0, 1.0))
        if s <= 0.0:
            return x, {"ran": False, "reason": "strength=0"}
        alpha = 1.0 + 1.6 * s
        floor_db = -16.0 - 16.0 * s
        gmin = 10.0 ** (floor_db / 20.0)               # amplitude gain floor
        f, t, Z = sps.stft(x, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP,
                           window=WIN, boundary="zeros", padded=True)
        mag = np.abs(Z); ph = np.angle(Z)
        P = mag ** 2
        # Stationary noise PSD per bin = MEAN of the quietest frames (the residual
        # bed after DFN is stationary, so an average over the low-energy frames is
        # representative — a per-bin low percentile underestimates it and leaves
        # the over-subtraction short of the floor on noise-only frames).
        frame_e = P.mean(axis=0)
        thr = np.percentile(frame_e, noise_pct)
        quiet = frame_e <= max(thr, EPS)
        if quiet.sum() < 3:
            noise = np.percentile(P, noise_pct, axis=1, keepdims=True)
        else:
            noise = P[:, quiet].mean(axis=1, keepdims=True)
        noise = np.maximum(noise, EPS)
        # over-subtracted clean-power estimate → smooth Wiener gain in [gmin,1).
        clean_p = np.maximum(P - alpha * noise, 0.0)
        G = np.maximum(clean_p / (clean_p + noise), gmin)
        if smooth_bins and smooth_bins > 1:            # smooth across frequency
            kf = np.ones(smooth_bins, dtype=np.float32) / smooth_bins
            G = np.apply_along_axis(lambda c: np.convolve(c, kf, mode="same"), 0, G)
        if smooth_frames and smooth_frames > 1:        # smooth across time
            kt = np.ones(smooth_frames, dtype=np.float32) / smooth_frames
            G = np.apply_along_axis(lambda c: np.convolve(c, kt, mode="same"), 1, G)
        Zc = G * mag * np.exp(1j * ph)
        _, y = sps.istft(Zc, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP,
                         window=WIN, boundary=True)
        if len(y) < len(x):
            y = np.pad(y, (0, len(x) - len(y)))
        peak = float(np.max(np.abs(x)) + EPS)
        y = np.clip(y[:len(x)], -peak, peak).astype(np.float32)
        # Report the NOISE-BED change, not the global RMS: the bed lives in the
        # pauses, so global RMS (speech-dominated) barely moves and would read as
        # "no effect". Bed = RMS of the quietest 20% of 30 ms windows.
        def _bed(sig):
            w = max(1, int(0.03 * fs))
            e = [float(np.sqrt(np.mean(sig[i:i + w] ** 2)))
                 for i in range(0, max(1, len(sig) - w), w)]
            return float(np.percentile(e, 20)) + EPS if e else EPS
        bed_in, bed_out = _bed(x), _bed(y)
        return y, {"ran": True, "strength": round(s, 2), "alpha": round(alpha, 2),
                   "floor_db": round(floor_db, 1),
                   "bed_change_db": round(20.0 * np.log10(bed_out / bed_in), 1),
                   "rms_change_db": round(20.0 * np.log10(
                       (np.sqrt(np.mean(y ** 2)) + EPS) / (np.sqrt(np.mean(x ** 2)) + EPS)), 1)}
    except Exception as e:
        print(f"[WARN] residual_suppress failed: {e}")
        return np.asarray(x, dtype=np.float32), {"ran": False, "reason": f"error: {e}"}


# =========================================================================
#  MAIN ORCHESTRATOR
# =========================================================================
def run_production(input_path, out_dir, *, reference_path=None,
                   nr="dfn", dfn_atten_lim_db=32.0, beam="auto",
                   mvdr_blend=0.6, wpe=False, eq=True,
                   agc="rms", aec="partitioned", movement="rtf",
                   track="conditioned", dereverb=None, mask="auto",
                   residual=0.6, pause_floor_db=-40.0,
                   target_az=None, interferer_az=None,
                   doa_readout=False, report=True, log=None):
    """Run the production voice pipeline on one 8-channel WAV → one clean mono WAV.

    Parameters
    ----------
    input_path : str | Path     -- 8-ch 48 kHz WAV (same files the app consumes).
    out_dir    : str | Path     -- /output root; writes ``<stem>/clean_prod.wav``
                                   (never clobbers ``clean_cascade.wav`` or the
                                   instrument outputs).
    reference_path : str | Path | None
        Optional far-end loudspeaker reference WAV for stage [7] AEC. When None
        (the usual case for mic-only OCTOVOX recordings) AEC is a clean skip.
    nr : "dfn" | "fast" | "none"
        Noise-reduction engine (stage [8b]). ``dfn`` = DeepFilterNet3 (the
        DEFAULT — neural, natural-sounding voice with no musical noise; on this
        hardware it is barely slower than the spectral path). ``fast`` = the
        decision-directed :func:`dd_wiener` (quick, no neural cost, and far less
        'robotic' than plain spectral subtraction). ``none`` = beam only.
    dfn_atten_lim_db : float | None
        Max suppression DFN3 is allowed to apply (stage [8b]). The DEFAULT is
        ``32.0`` — raised from the old 24 dB so DFN suppresses the residual noise
        bed harder while staying natural. ``None`` uncaps it (most aggressive);
        lower values keep a quieter 2nd speaker. See clean_cascade.
    beam : "auto" | "batch" | "tracked"
        Beamformer (stage [6]). ``auto`` (DEFAULT) uses the ``movement`` selector
        to switch to the tracked beam only on genuine sustained movement, else it
        runs the cheaper *and* better batch RTF-MVDR (the 500-trial bootstrap
        ranks batch above tracked on ~15/21 of these clips, 30.9 vs 28.4 dB
        median-SNR). ``auto``+batch is also the ONLY path the spatial-coherence
        ``mask`` applies to, so ``beam="auto"`` is faster, higher-SNR on most
        recordings, and re-enables the ASA mask gain. ``batch``/``tracked`` force
        the choice (and, when forced, the movement detectors are skipped — see
        ``doa_readout``).
    movement : "srp" | "rtf"
        Which signal drives the ``beam="auto"`` batch-vs-tracked decision.
        ``srp`` (legacy) = SRP-PHAT azimuth spread — front/back ambiguous
        on this UCA, so its movement flag is reported but NOT acted on (auto stays
        on batch). ``rtf`` (DEFAULT) = :func:`rtf_drift`, an ambiguity-free RTF-drift
        detector that auto WILL act on (switch to tracked) when it reports
        sustained movement. SRP-PHAT still runs for the azimuth readout either way.
    track : "conditioned" | "audio"
        Tracking-path source (stage [5·track], a Biamp-style audio/tracking
        split). ``conditioned`` (DEFAULT) feeds the DOA + RTF-drift trackers a
        noise-robust, speech-band, phase-preserving COPY of the array (via
        :func:`condition_tracking_path`) so HVAC/projector noise can't hijack the
        beam direction; the audio/beamformer path is untouched. ``audio`` tracks
        on the raw audio path (legacy). NOT a latency feature.
    mask : "snr" | "coherent" | "auto"
        Speech/noise mask for the BATCH RTF-MVDR covariance build (stage [6]).
        ``snr`` = the instrument's energy soft-mask. ``coherent`` fuses
        the spatial-coherence (ASA "common location") cue so diffuse reverb/noise
        is pushed into the noise covariance — large SNR gains on multi-talker /
        moving / reverberant clips (+4 to +12 dB) but a mild regression on
        already-clean single-talker ones. ``auto`` (DEFAULT) builds both beams and
        keeps the one an independent proxy prefers — "never worse than baseline"
        (keeps the ~+1.8 dB mean gain, worst case only −0.5 dB). Only affects the
        batch beam.
    mvdr_blend : float in [0,1]
        MVDR↔downmix blend so off-axis speakers survive (see clean_cascade).
    dereverb : "none" | "spectral" | "wpe" | None
        Dereverberation engine. ``none`` (DEFAULT) skips it. ``spectral`` =
        :func:`dereverb_spectral`, a fast single-channel late-reverb suppressor
        that runs on the beamformed mono (~0.02× real-time, removes 2–4× more
        reverb tail than WPE on these clips). ``wpe`` = the multichannel
        :func:`pipeline.wpe_dereverberate` front-end (runs BEFORE the beam, the
        principled spot for multichannel dereverb, but ~3× real-time — the
        slowest stage; stable ``taps=8, iterations=2``). When ``None``, it is
        derived from the legacy ``wpe`` flag (``wpe=True`` → ``"wpe"``).
    wpe : bool
        DEPRECATED back-compat alias — ``wpe=True`` is equivalent to
        ``dereverb="wpe"`` when ``dereverb`` is not given.
    eq  : bool   -- apply the speech EQ (stage [10]).
    agc : "perceptual" | "rms"
        Loudness control (stage [10]). ``perceptual`` =
        :func:`perceptual_agc` — K-weighted attack/release loudness riding, more
        natural on speech with dynamics. ``rms`` (DEFAULT) = the instrument's
        instantaneous :func:`pipeline.agc_to_dbfs`.
    aec : "partitioned" | "single"
        Echo canceller (stage [7], only active with a far-end ``reference_path``).
        ``partitioned`` (DEFAULT) = :func:`aec_partitioned` (multi-tap, long echo
        tail). ``single`` = the compact one-tap :func:`aec_nlms`.
    residual : float in [0,1] | None
        Strength of the residual stationary-noise suppressor (stage [8c],
        :func:`residual_suppress`) — a gentle SECOND NR pass that mops up the
        quiet steady hiss/hum DFN3 leaves behind. The DEFAULT ``0.6`` is the
        "strong but natural" setting; ``0`` / ``None`` turns the stage off, ``1``
        is the most aggressive (near-silent bed, small risk of warble). This is
        the main "denoise strength" knob exposed in the UI.
    pause_floor_db : float
        Silence floor for the automix gate (stage [9]). The DEFAULT ``-40.0``
        (deepened from -24) pushes the noise in speech *pauses* well down so
        gaps go near-silent; raise toward -24 for a softer, less gated feel.
    target_az : float | None
        **Target-speaker selection (stage [6]).** When given an azimuth in degrees,
        the beamformer is replaced by :func:`extract_direction` — a direction-masked
        RTF-MVDR steered at ``target_az`` that keeps the talker in that direction and
        nulls the others. This is the "whose voice?" picker for multi-talker
        recordings; ``None`` (default) keeps the normal single-beam behaviour. When
        set, ``beam``/``mask``/``mvdr_blend`` are bypassed (the downmix blend would
        re-introduce the other talkers).
    interferer_az : list[float] | None
        The OTHER talker azimuths, used to make the target mask COMPETITIVE (see
        :func:`extract_direction`). When ``target_az`` is set but this is ``None``,
        the other directions are found automatically via
        :func:`detect_talker_directions`. Ignored when ``target_az`` is ``None``.
    doa_readout : bool
        Whether to run the SRP-PHAT :func:`track_doa` azimuth READOUT (stage
        [5]). It is a *diagnostic* — on this UCA the azimuth is front/back
        ambiguous, so it never drives the beam decision (only the ambiguity-free
        :func:`rtf_drift` does, and only in ``beam="auto"`` + ``movement="rtf"``).
        The DEFAULT ``False`` therefore SKIPS it (and its multichannel STFT +
        per-block covariance build) for speed; it still runs automatically when it
        is actually needed for the auto decision (``movement="srp"``). Set ``True``
        to populate the azimuth readout in the report.
    report : bool
        Whether to render the standalone HTML report + matplotlib figure (stage
        [report]). The DEFAULT ``True`` keeps direct/library callers' behaviour;
        the ``/api/clean`` endpoint defaults it OFF so the per-request matplotlib
        render (200–700 ms) is opt-in. When ``False``, ``report_name`` is ``None``.
    log : callable | None  -- optional progress sink.

    Returns
    -------
    dict with ``{clean_path, clean_name, stem, sr, n_channels, stages, timings,
    elapsed_s}``. ``stages`` is an ordered ran/skip report; ``timings`` is the
    per-stage wall-clock in ms so the time budget is measurable.
    """
    from . import pipeline as ov

    # Resolve the dereverb engine, honouring the legacy ``wpe`` flag when the
    # newer ``dereverb`` selector is not explicitly supplied.
    if dereverb is None:
        dereverb = "wpe" if wpe else "none"
    if dereverb not in ("none", "spectral", "wpe"):
        dereverb = "none"

    def _log(msg):
        if log:
            try: log(msg)
            except Exception: pass

    t0 = time.time()
    input_path = Path(input_path)
    out_dir = Path(out_dir)
    stages = OrderedDict()
    timings = OrderedDict()

    def _stage(name, fn):
        """Run ``fn`` (returns an info dict or (value, info)), record timing."""
        ts = time.time()
        res = fn()
        timings[name] = round((time.time() - ts) * 1000.0, 1)
        return res

    # ── [1] load (mic capsules) ───────────────────────────────────────
    y, sr = _stage("load", lambda: _load_multichannel(input_path))
    D, n = y.shape
    stages["mic_capsules"] = {"ran": True, "n_channels": int(D), "sr": int(sr),
                              "samples": int(n), "duration_s": round(n / sr, 3)}
    _log(f"prod: loaded {D}ch × {n} ({n/sr:.2f}s) @ {sr} Hz")
    # Keep a raw-input mono reference (non-directional downmix) for A/B playback.
    raw_downmix = y.mean(axis=0).astype(np.float32)

    # ── [2b] mic health diagnostic — on the RAW input, before calibration ─
    stages["mic_health"] = _stage("mic_health", lambda: mic_health_report(y, sr))
    if stages["mic_health"].get("ran"):
        c = stages["mic_health"]["counts"]
        _log(f"prod: mic health — OK {c['OK']} · WARN {c['WARN']} · "
             f"FAULT {c['FAULT']} · DEAD {c['DEAD']} · CLIP {c['CLIP']}")

    # ── [2] channel gain calibration ──────────────────────────────────
    y, info = _stage("calibrate", lambda: calibrate_channels(y, sr))
    stages["calibrate"] = info
    _log(f"prod: channel calibration {'done' if info.get('ran') else 'skipped'}")

    # ── [3] high-pass + noise-floor estimation ────────────────────────
    y, info = _stage("highpass", lambda: highpass(y, sr))
    stages["highpass"] = info
    stages["noise_floor"] = _stage("noise_floor", lambda: estimate_noise_floor(y, sr))
    _log(f"prod: HPF {info.get('cutoff_hz', '–')} Hz; "
         f"noise floor {stages['noise_floor'].get('noise_floor_dbfs', '?')} dBFS")

    # ── [8a] WPE dereverb — MULTICHANNEL FRONT-END (runs before beamform) ─
    #  Only when dereverb="wpe". Stable params (taps=8, iters=2): WPE diverges at
    #  iters=1 and corrupts speech. Slowest stage (~3× real-time), so opt-in. The
    #  fast dereverb="spectral" path instead runs on the mono AFTER beamforming.
    if dereverb == "wpe" and getattr(ov, "HAS_WPE", False) and D > 1:
        def _do_wpe():
            x_sc = ov.wpe_dereverberate(y.T, sr, taps=8, delay=3, iterations=2)
            x_sc = np.ascontiguousarray(x_sc.T)
            # Guard WPE's overshoot: clamp each channel to its input peak so the
            # downmix never exceeds [-1,1] (else Silero VAD reports 0% speech).
            for c in range(x_sc.shape[0]):
                pk = float(np.max(np.abs(y[c])) + EPS)
                np.clip(x_sc[c], -pk, pk, out=x_sc[c])
            return x_sc.astype(np.float32)
        y = _stage("dereverb_wpe", _do_wpe)
        stages["dereverb_wpe"] = {"ran": True, "engine": "wpe", "taps": 8, "iterations": 2,
                                  "note": "multichannel front-end (before beamform)"}
    else:
        why = ("disabled (dereverb=none/spectral)" if dereverb != "wpe" else
               "nara-wpe unavailable" if not getattr(ov, "HAS_WPE", False) else "single channel")
        stages["dereverb_wpe"] = {"ran": False, "reason": why}
    _log(f"prod: WPE dereverb {'done' if stages['dereverb_wpe'].get('ran') else 'skipped'}")

    # ── [4] VAD / speech detector (on the array downmix) ───────────────
    def _vad_detect():
        if not getattr(ov, "HAS_VAD", False):
            return {"ran": False, "reason": "Silero VAD unavailable"}
        # Silero expects an in-range signal; intermediate downmixes can exceed
        # [-1,1] (e.g. after dereverb), which makes Silero report no speech.
        # Normalize to a safe peak first so detection is level-robust.
        dm, _ = _peak_normalize(y.mean(axis=0).astype(np.float32))
        probs = ov.silero_vad_mask(dm, sr)
        if probs is None or len(probs) == 0:
            return {"ran": False, "reason": "VAD returned no frames"}
        probs = np.asarray(probs, dtype=np.float32)
        sp = float((probs > 0.5).mean())
        return {"ran": True, "speech_ratio": round(sp, 3), "total_frames": int(len(probs))}
    stages["vad"] = _stage("vad", _vad_detect)
    _log(f"prod: VAD speech ratio {stages['vad'].get('speech_ratio', '?')}")

    # ── [5·track / 5 / 5b]  TRACKING — only run the detectors that matter ─────
    #  The beam decision is driven by EXACTLY ONE signal: rtf_drift, and only when
    #  beam="auto" + movement="rtf" (SRP-PHAT azimuth is front/back ambiguous on
    #  this UCA, so it never switches the beam — see the beam-select comment). So:
    #    · rtf_drift   runs only when it can actually change the beam,
    #    · track_doa   is a *diagnostic* azimuth readout — run only when explicitly
    #                  requested (doa_readout) or when movement="srp"+auto selects it,
    #    · the tracking-path conditioner (an 8-ch zero-phase band-pass) runs only
    #      when one of those trackers will consume it.
    #  When beam is FORCED (batch/tracked) and no readout is asked for, all three
    #  are skipped — they were pure wasted compute on the forced paths.
    need_movement = (beam == "auto")
    run_rtf = need_movement and movement == "rtf"
    run_doa = doa_readout or (need_movement and movement == "srp")
    run_trackers = run_rtf or run_doa

    if track == "conditioned" and run_trackers:
        y_track, tc_info = _stage("track_conditioning", lambda: condition_tracking_path(y, sr))
    elif track == "conditioned":
        y_track, tc_info = y, {"ran": False, "reason": "skipped (no tracker active for this beam)"}
    else:
        y_track, tc_info = y, {"ran": False, "reason": "disabled (tracking uses the audio path)"}
    stages["track_conditioning"] = tc_info
    _log(f"prod: tracking path {'conditioned ' + str(tc_info.get('band_hz')) if tc_info.get('ran') else 'raw (audio path)'}")

    # ── [5] DOA / talker tracking — azimuth readout (diagnostic only) ─
    if run_doa:
        doa_info, doa_moved = _stage("doa", lambda: track_doa(y_track, sr, ov.POLARIS_UCA_M))
        _log(f"prod: DOA spread {doa_info.get('az_spread_deg', '?')}° → "
             f"{'moving' if doa_moved else 'static'} talker")
    else:
        doa_info, doa_moved = {"ran": False,
                               "reason": "skipped (diagnostic readout; not needed for this beam)"}, False
    stages["doa"] = doa_info

    # ── [5b] movement selector — RTF drift (the only signal that switches) ─
    if run_rtf:
        rtf_info, moved = _stage("rtf_drift", lambda: rtf_drift(y_track, sr))
        stages["rtf_drift"] = rtf_info
        _log(f"prod: RTF drift steady-median {rtf_info.get('steady_median', '?')} → "
             f"{'moving' if moved else 'static'} talker")
    elif movement == "rtf":
        stages["rtf_drift"] = {"ran": False, "reason": "skipped (beam forced; movement signal unused)"}
        moved = doa_moved
    else:
        moved = doa_moved

    # ── [6] beamforming / beam tracking / lobe steering (8→1) ─────────
    #  "auto" defaults to the BATCH RTF-MVDR: it is cheaper and the instrument's
    #  500-trial bootstrap ranks it above the tracked variant on ~15/21 clips.
    #  With movement="srp" the per-block DOA is front/back ambiguous on this UCA,
    #  so its "moved" flag is NOT trusted to switch (auto stays on batch). With
    #  movement="rtf" the RTF-drift signal IS trustworthy, so auto switches to the
    #  tracked beam when it reports SUSTAINED movement. beam="tracked"/"batch"
    #  force the choice regardless.
    #  TARGET-SPEAKER MODE: when ``target_az`` is set, replace the beam with a
    #  direction-masked extraction steered at that talker (and null the others).
    target_mode = target_az is not None
    interfs = []
    if target_mode:
        if interferer_az is None:
            det = detect_talker_directions(
                y_track if tc_info.get("ran") else y, sr, ov.POLARIS_UCA_M)
            interfs = [s["az"] for s in det.get("speakers", [])
                       if abs((s["az"] - float(target_az) + 180) % 360 - 180) >= 20]
        else:
            interfs = [a for a in interferer_az
                       if abs((float(a) - float(target_az) + 180) % 360 - 180) >= 20]
        chosen = None
        method = "extract_direction"
        use_masked = False
    elif beam == "tracked":
        chosen = tracked_mvdr_beamform
    elif beam == "batch":
        chosen = batch_mvdr_beamform
    elif movement == "rtf" and moved:        # "auto" + trustworthy movement signal
        chosen = tracked_mvdr_beamform
    else:                                    # "auto"
        chosen = batch_mvdr_beamform
    if not target_mode:
        method = getattr(chosen, "__name__", "beamform")
        # The spatial-coherence (ASA) mask only applies to the BATCH beam.
        use_masked = (chosen is batch_mvdr_beamform) and (mask != "snr")
    mask_meta = {"mask": "snr"}

    def _beamform():
        nonlocal mask_meta
        if target_mode:
            # Direction-extracted: keep the chosen talker, null the rest. No
            # downmix blend — that would re-introduce the other voices.
            mvdr = np.asarray(
                extract_direction(y, sr, ov.POLARIS_UCA_M, float(target_az),
                                  interferer_az=interfs),
                dtype=np.float32).reshape(-1)
        elif use_masked:
            mvdr_raw, mask_meta = beamform_masked(y, sr, mask_mode=mask)
            mvdr = np.asarray(mvdr_raw, dtype=np.float32).reshape(-1)
        else:
            mvdr = np.asarray(chosen(y, sr), dtype=np.float32).reshape(-1)
        if mvdr.size == 0 or not np.all(np.isfinite(mvdr)):
            raise ValueError("beamformer returned empty/non-finite output")
        if len(mvdr) < n:
            mvdr = np.pad(mvdr, (0, n - len(mvdr)))
        mvdr = mvdr[:n]
        if (not target_mode) and D > 1 and 0.0 < mvdr_blend < 1.0:
            downmix = y.mean(axis=0)[:n].astype(np.float32)
            mvdr_n, _ = _peak_normalize(mvdr, target=1.0)
            dmix_n, _ = _peak_normalize(downmix, target=1.0)
            mono = (mvdr_blend * mvdr_n + (1.0 - mvdr_blend) * dmix_n).astype(np.float32)
            note = f"MVDR×{mvdr_blend:.2f}+downmix×{1-mvdr_blend:.2f}"
        else:
            mono = mvdr
            note = f"target @{int(round(float(target_az)))}°" if target_mode else "pure MVDR"
        mono, gbf = _peak_normalize(mono)
        return mono, note, gbf
    try:
        mono, blend_note, gbf = _stage("beamform", _beamform)
        stages["beamform"] = {"ran": True, "method": method, "beam_mode": beam,
                              "moving_talker": bool(moved), "blend": blend_note,
                              "mask": mask, "mask_info": mask_meta,
                              "peak_norm_db": round(gbf, 1)}
        if target_mode:
            stages["beamform"].update({"target_az": int(round(float(target_az))),
                                       "interferer_az": [int(a) for a in interfs]})
        _log(f"prod: beamform {method} 8→1 ({blend_note})"
             + (f" · nulling {interfs}" if target_mode else f" · mask={mask}"
                + (f" → {mask_meta.get('picked')}" if mask_meta.get('mask') == 'auto' else "")))
    except Exception as e:
        mono = y.mean(axis=0)[:n].astype(np.float32)
        stages["beamform"] = {"ran": True, "method": "channel_mean_fallback", "reason": str(e)}
        _log(f"prod: beamform failed ({e}); used channel-mean fallback")

    # ── [7] AEC with far-end reference (no-op unless reference supplied) ─
    far_ref = None
    if reference_path is not None:
        try:
            ry, _ = _load_multichannel(reference_path)
            far_ref = ry.mean(axis=0)
        except Exception as e:
            stages["aec"] = {"ran": False, "reason": f"reference load failed: {e}"}
    if "aec" not in stages:
        aec_fn = aec_partitioned if aec != "single" else aec_nlms
        mono, info = _stage("aec", lambda: aec_fn(mono, far_ref, sr))
        stages["aec"] = info
    _log(f"prod: AEC ({aec}) {'applied' if stages['aec'].get('ran') else 'skipped'}")

    # ── [7b] feedback / howling risk — read-only diagnostic on the beam ─
    stages["feedback_risk"] = _stage("feedback_risk", lambda: feedback_risk(mono, sr))
    _log(f"prod: feedback risk {stages['feedback_risk'].get('risk', '?')}")

    # ── [8a·spectral] fast single-channel dereverb on the mono beam ───
    #  The cheap alternative to the multichannel WPE front-end: ~0.02× real-time,
    #  stable (no overshoot), and removes more of the reverb tail on these clips.
    if dereverb == "spectral":
        def _do_spec():
            rev_in = float(np.mean(mono ** 2) + EPS)
            out = dereverb_spectral(mono.astype(np.float32), sr)
            rev_out = float(np.mean(out ** 2) + EPS)
            return out, {"ran": True, "engine": "spectral",
                         "rms_change_db": round(10.0 * np.log10(rev_out / rev_in), 1)}
        mono, info = _stage("dereverb_spectral", _do_spec)
        stages["dereverb_spectral"] = info
    else:
        stages["dereverb_spectral"] = {"ran": False,
                                       "reason": f"disabled (dereverb={dereverb})"}
    _log(f"prod: spectral dereverb {'done' if stages['dereverb_spectral'].get('ran') else 'skipped'}")

    # ── [8b] noise reduction (single channel) ─────────────────────────
    def _nr():
        if nr == "none":
            return mono, {"ran": False, "reason": "disabled (nr=none)"}
        if nr == "dfn":
            if getattr(ov, "_DFN_AVAILABLE", False) and sr == SR_DFN:
                out = _dfn_enhance(mono.astype(np.float32), sr, atten_lim_db=dfn_atten_lim_db)
                if out is not None:
                    o = np.asarray(out, dtype=np.float32).reshape(-1)
                    if len(o) < n: o = np.pad(o, (0, n - len(o)))
                    return o[:n], {"ran": True, "engine": "DeepFilterNet3",
                                   "atten_lim_db": dfn_atten_lim_db}
                return mono, {"ran": False, "reason": "DFN enhance returned None"}
            return mono, {"ran": False, "reason": "DFN unavailable / sr≠48k"}
        # fast spectral NR — decision-directed (low musical-noise, non-robotic)
        out = dd_wiener(mono.astype(np.float32), sr)
        o = np.asarray(out, dtype=np.float32).reshape(-1)
        if len(o) < n: o = np.pad(o, (0, n - len(o)))
        return o[:n], {"ran": True, "engine": "dd_wiener"}
    mono, info = _stage("nr", _nr)
    stages["noise_reduction"] = info
    _log(f"prod: NR {info.get('engine', 'skipped')} ({'ran' if info.get('ran') else info.get('reason')})")

    # ── [8c] residual stationary-noise suppressor ─────────────────────
    #  Second, gentle NR pass to mop up the steady hiss/hum the (naturalness-
    #  capped) DFN3 leaves behind. Off when residual is 0/None.
    if residual and float(residual) > 0:
        mono, info = _stage("residual",
                            lambda: residual_suppress(mono, sr, strength=float(residual)))
        stages["residual_suppress"] = info
    else:
        stages["residual_suppress"] = {"ran": False,
                                       "reason": f"disabled (residual={residual})"}
    _log(f"prod: residual suppressor "
         f"{stages['residual_suppress'].get('rms_change_db', 'skipped')}"
         f"{' dB' if stages['residual_suppress'].get('ran') else ''}")

    # ── [9] automix / gating / beam weighting ─────────────────────────
    #  Normalize first so the gating VAD (Silero) always sees an in-range signal.
    mono, _ = _peak_normalize(mono)
    mono, info = _stage("automix", lambda: automix(mono, sr, floor_db=pause_floor_db))
    stages["automix"] = info
    _log(f"prod: automix {'applied' if info.get('ran') else 'skipped'}")

    # ── [10] AGC + EQ + limiter ───────────────────────────────────────
    def _apply_agc(sig):
        """Loudness control — perceptual (attack/release) or instantaneous RMS."""
        if agc == "rms":
            return ov.agc_to_dbfs(sig.astype(np.float32), ov.TARGET_DBFS), {"engine": "rms"}
        out, info = perceptual_agc(sig.astype(np.float32), sr, target_dbfs=ov.TARGET_DBFS)
        # Fall back to the RMS AGC if the perceptual pass failed for any reason.
        if not info.get("ran"):
            return ov.agc_to_dbfs(sig.astype(np.float32), ov.TARGET_DBFS), {"engine": "rms", **info}
        return out, info

    def _agc_eq_lim():
        x, agc_info = _apply_agc(mono)
        eq_info = {"ran": False, "reason": "disabled"}
        if eq:
            x, eq_info = apply_eq(x, sr)
        x, _ = _apply_agc(x)                          # re-trim after EQ
        x = ov.soft_limit(x.astype(np.float32), ceiling=0.9)
        return x.astype(np.float32), (eq_info, agc_info)
    mono, (eq_info, agc_info) = _stage("agc_eq_limiter", _agc_eq_lim)
    stages["agc_eq_limiter"] = {"ran": True, "agc_target_dbfs": ov.TARGET_DBFS,
                                "agc": agc_info, "eq": eq_info, "limiter_ceiling": 0.9}
    _log(f"prod: AGC ({agc_info.get('engine', agc)})→{ov.TARGET_DBFS} dBFS + EQ + limiter done")

    # ── [11] output: peak-normalize + write clean mono WAV ────────────
    mono, gout = _peak_normalize(mono)
    stages["output"] = {"ran": True, "gain_db": round(gout, 1), "target_peak": 0.9,
                        "transport": "WAV (USB/analog playout via /api/playout; "
                                     "Dante/AVB need vendor hardware SDKs)"}
    stem = input_path.stem
    rec_dir = out_dir / stem
    rec_dir.mkdir(parents=True, exist_ok=True)
    clean_path = rec_dir / "clean_prod.wav"
    _save_mono(clean_path, mono, sr)
    # Raw-input mono reference (peak-normalized) so the UI can A/B raw vs clean.
    input_mono, _ = _peak_normalize(raw_downmix)
    input_path_mono = rec_dir / "input_mono.wav"
    _save_mono(input_path_mono, input_mono, sr)
    _log(f"prod: wrote {clean_path}")

    elapsed = round(time.time() - t0, 2)
    timings["TOTAL"] = round(elapsed * 1000.0, 1)

    # ── standalone HTML report (opt-in; never fails the clean run) ────
    #  The matplotlib render is 200–700 ms of wall-clock the caller waits on, so
    #  it is OFF by default on the API hot path. ``report=True`` re-enables it.
    if report:
        from . import prod_report
        params_str = ((f"target@{int(round(float(target_az)))}° · " if target_az is not None else "")
                      + f"NR:{nr} · beam:{beam} · move:{movement} · AGC:{agc} · "
                      f"AEC:{aec}" + (" · track" if track == "conditioned" else "")
                      + (f" · mask:{mask}" if mask != "snr" else "")
                      + (f" · derev:{dereverb}" if dereverb != "none" else "")
                      + (" · EQ" if eq else ""))
        rep = _stage("report", lambda: prod_report.build_report(
            out_dir, stem, input_path.name,
            raw_mono=raw_downmix, clean_mono=mono, sr=sr,
            stages=stages, timings=timings, elapsed_s=elapsed,
            clean_path=clean_path, input_path=input_path_mono, params=params_str))
        stages["report"] = rep
        _log(f"prod: report {'written' if rep.get('ran') else 'skipped (' + str(rep.get('reason')) + ')'}")
    else:
        rep = {"ran": False, "reason": "report disabled (report=False)"}
        stages["report"] = rep
        _log("prod: report skipped (disabled)")

    return {
        "clean_path": str(clean_path),
        "clean_name": clean_path.name,
        "input_name": input_path_mono.name,
        "report_name": rep.get("report_name") if rep.get("ran") else None,
        "stem": stem,
        "sr": int(sr),
        "n_channels": int(D),
        "stages": stages,
        "timings": timings,
        "elapsed_s": elapsed,
    }
