#!/usr/bin/env python3
"""
=========================================================================
  BLIND RT60 ESTIMATION  —  measured reverberation time from a recording
=========================================================================
Estimates the room's reverberation time **per octave band** directly from a
recording (no controlled impulse / sine-sweep needed), so it can be compared
against the geometry-based *prediction* from the room-acoustics module.

Method (classical, "free-decay" Schroeder):

  1. Band-pass the signal into the six standard octave bands
     [125, 250, 500, 1000, 2000, 4000] Hz.
  2. Build a short-time energy envelope (dB) and detect **free-decay** regions —
     the tails after a sound source switches off, where only the room is
     decaying (sustained, monotonic-ish energy drop).
  3. Over each decay, run Schroeder backward integration to get the energy-decay
     curve (EDC) and fit its linear portion; slope (dB/s) → RT60 = −60 / slope.
  4. Keep fits that are clean (R² high, plausible RT60) and report the **median**
     per band.

This is a *blind* estimate from running speech/sound — approximate by nature
(it depends on the recording actually containing audible decays). Bands with no
reliable decay return ``None``. It is not a substitute for a measured
impulse-response (sweep) commissioning.
=========================================================================
"""
import numpy as np
import scipy.signal as sps

#: Standard octave-band centre frequencies (Hz) — matches the acoustics module.
OCTAVE_BANDS = (125, 250, 500, 1000, 2000, 4000)

# Envelope framing.
_WIN_MS = 25.0
_HOP_MS = 10.0
_EPS = 1e-12


def _octave_sos(fc, fs, order=4):
    """4th-order Butterworth band-pass SOS for one octave band centred at ``fc``."""
    lo = fc / np.sqrt(2.0)
    hi = min(fc * np.sqrt(2.0), 0.99 * fs / 2.0)
    return sps.butter(order, [lo, hi], btype="band", fs=fs, output="sos")


def _envelope_db(x, fs):
    """Short-time energy envelope in dB plus the frame time axis and hop/win."""
    win = max(1, int(_WIN_MS * fs / 1000.0))
    hop = max(1, int(_HOP_MS * fs / 1000.0))
    n = len(x)
    if n < win:
        return np.array([0.0]), np.array([-120.0]), hop, win
    n_fr = 1 + (n - win) // hop
    e = np.empty(n_fr, dtype=np.float64)
    for i in range(n_fr):
        seg = x[i * hop : i * hop + win]
        e[i] = float(np.dot(seg, seg)) + _EPS
    edb = 10.0 * np.log10(e)
    t = np.arange(n_fr) * hop / fs
    return t, edb, hop, win


def _find_decays(t, edb, min_drop_db=18.0, min_len_s=0.15, rise_tol_db=2.0):
    """Detect free-decay regions: sustained energy drops in the envelope.

    A region starts where the level begins to fall and extends while it keeps
    decreasing (a small ``rise_tol_db`` wobble is allowed). It qualifies if it
    is at least ``min_len_s`` long and drops at least ``min_drop_db``.
    Returns a list of ``(start_frame, end_frame)`` index pairs.
    """
    decays = []
    n = len(edb)
    i = 0
    while i < n - 1:
        if edb[i + 1] < edb[i]:
            peak = edb[i]
            k = i
            lowest = edb[i]
            while k < n - 1 and edb[k + 1] <= edb[k] + rise_tol_db and edb[k + 1] < peak:
                k += 1
                lowest = min(lowest, edb[k])
            if (t[k] - t[i]) >= min_len_s and (peak - lowest) >= min_drop_db:
                decays.append((i, k))
            i = max(k, i + 1)
        else:
            i += 1
    return decays


def _rt60_from_segment(energy, fs, r2_min, rt60_range, span_min_db=12.0):
    """Schroeder EDC over one decay segment → RT60, or ``None`` if the fit is poor.

    Backward-integrates the per-sample energy, fits the linear region between
    −5 dB and the onset of the noise floor, and extrapolates the slope to 60 dB.
    """
    if energy.size < 8:
        return None
    edc = np.cumsum(energy[::-1])[::-1]
    edc_db = 10.0 * np.log10(edc / (edc[0] + _EPS) + _EPS)
    t = np.arange(edc_db.size) / fs
    floor = float(edc_db.min())
    # Fit from −5 dB down to a few dB above the integration floor (avoid the tail).
    hi, lo = -5.0, floor + 3.0
    mask = (edc_db <= hi) & (edc_db >= lo)
    if int(mask.sum()) < 10 or (hi - lo) < span_min_db:
        return None
    slope, intercept = np.polyfit(t[mask], edc_db[mask], 1)
    if slope >= 0:
        return None
    pred = slope * t[mask] + intercept
    ss_res = float(np.sum((edc_db[mask] - pred) ** 2))
    ss_tot = float(np.sum((edc_db[mask] - edc_db[mask].mean()) ** 2)) + _EPS
    r2 = 1.0 - ss_res / ss_tot
    rt60 = -60.0 / slope
    if r2 < r2_min or not (rt60_range[0] <= rt60 <= rt60_range[1]):
        return None
    return float(rt60), float(r2)


def measure_rt60(y, fs, bands=OCTAVE_BANDS, r2_min=0.9, rt60_range=(0.1, 2.5)):
    """Estimate per-octave-band RT60 from a recording.

    ``y`` is a mono signal (1-D). Returns::

        {
          "ran": bool,                       # at least one band estimated
          "bands": [{"band": int, "rt60": float|None, "n_decays": int}, ...],
          "overall_rt60": float|None,        # median across estimated bands
          "n_decays": int,                   # total accepted decays
          "method": "free-decay-schroeder",
        }
    """
    y = np.asarray(y, dtype=np.float64).ravel()
    if y.size < int(0.3 * fs):
        return {"ran": False, "reason": "recording too short", "bands": [],
                "overall_rt60": None, "n_decays": 0, "method": "free-decay-schroeder"}
    # Normalize so band-pass dynamic range is consistent.
    peak = float(np.max(np.abs(y))) + _EPS
    y = y / peak

    out = []
    total = 0
    for fc in bands:
        sos = _octave_sos(fc, fs)
        xb = sps.sosfiltfilt(sos, y)
        energy = xb * xb
        t, edb, hop, win = _envelope_db(xb, fs)
        rts = []
        for (i, k) in _find_decays(t, edb):
            a = i * hop
            b = min(energy.size, k * hop + win)
            r = _rt60_from_segment(energy[a:b], fs, r2_min, rt60_range)
            if r is not None:
                rts.append(r[0])
        if rts:
            out.append({"band": int(fc), "rt60": round(float(np.median(rts)), 3), "n_decays": len(rts)})
            total += len(rts)
        else:
            out.append({"band": int(fc), "rt60": None, "n_decays": 0})

    valid = [b["rt60"] for b in out if b["rt60"] is not None]
    overall = round(float(np.median(valid)), 3) if valid else None
    return {
        "ran": bool(valid),
        "bands": out,
        "overall_rt60": overall,
        "n_decays": total,
        "method": "free-decay-schroeder",
    }
