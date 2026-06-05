"""
Regression tests for the four DSP stages ported from the senior repo
(``oldneterpiseclaude``) into the OCTOVOX production pipeline:

    prod_pipeline.mic_health_report   — dead / clipping / deviant mic detection
    prod_pipeline.perceptual_agc      — K-weighted attack/release loudness AGC
    prod_pipeline.feedback_risk       — sustained-tone (howl) risk diagnostic
    prod_pipeline.aec_partitioned     — multi-tap STFT echo canceller

Each test uses short synthetic signals so it stays fast and deterministic.
"""
import numpy as np
import pytest

from octovox_app.services import prod_pipeline as prod
from octovox_app.services.prod_pipeline import (
    mic_health_report, perceptual_agc, feedback_risk, aec_partitioned, rtf_drift,
    condition_tracking_path, track_doa,
)
from octovox_app.services.pipeline import POLARIS_UCA_M, SPEED_SOUND

FS = 48000


def _speech_like(n, seed=0):
    """A non-stationary, band-limited noise burst — a crude speech surrogate."""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n).astype(np.float32)
    # amplitude-modulate so there are loud and quiet frames (for VAD/AGC logic)
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 3.0 * np.arange(n) / FS)
    return (x * env * 0.1).astype(np.float32)


def _frac_delay(x, ds):
    """Fractional-sample delay via FFT phase shift (sub-sample accurate)."""
    n = len(x)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n)
    return np.fft.irfft(X * np.exp(-1j * 2 * np.pi * f * ds), n=n).astype(np.float32)


def _planewave_8ch(src, az_deg, gains=None):
    """Render a mono source onto the 8-mic Polaris array as a plane wave from
    ``az_deg`` (per-mic propagation delays), optionally with per-mic gains."""
    direction = np.array([np.cos(np.deg2rad(az_deg)), np.sin(np.deg2rad(az_deg)), 0.0])
    taus = -(POLARIS_UCA_M @ direction) / SPEED_SOUND
    g = np.ones(len(taus)) if gains is None else gains
    return np.stack([g[m] * _frac_delay(src, t * FS) for m, t in enumerate(taus)])


# ---------------------------------------------------------------------------
#  mic_health_report
# ---------------------------------------------------------------------------
def test_mic_health_all_ok():
    n = FS // 2
    y = np.stack([_speech_like(n, seed=i) for i in range(8)])
    rep = mic_health_report(y, FS)
    assert rep["ran"] is True
    assert rep["n_channels"] == 8
    assert rep["all_ok"] is True
    assert rep["counts"]["OK"] == 8


def test_mic_health_flags_dead_and_clipping():
    n = FS // 2
    y = np.stack([_speech_like(n, seed=i) for i in range(8)])
    y[2] *= 1e-4                      # channel 2 → effectively disconnected (DEAD)
    y[5] = np.clip(y[5] * 50.0, -1.0, 1.0)   # channel 5 → driven into clipping
    rep = mic_health_report(y, FS)
    assert rep["ran"] is True
    assert rep["all_ok"] is False
    status = {m["mic"]: m["status"] for m in rep["per_mic"]}
    assert status[2] == "DEAD"
    assert status[5] == "CLIP"
    assert 2 in rep["flagged_mics"] and 5 in rep["flagged_mics"]


def test_mic_health_single_channel_skips():
    rep = mic_health_report(_speech_like(FS // 4)[None, :], FS)
    assert rep["ran"] is False


# ---------------------------------------------------------------------------
#  perceptual_agc
# ---------------------------------------------------------------------------
def test_perceptual_agc_raises_quiet_signal_without_clipping():
    n = FS
    quiet = _speech_like(n, seed=1) * 0.05            # well below target
    y, info = perceptual_agc(quiet, FS, target_dbfs=-23.0)
    assert info["ran"] is True
    assert info["engine"] == "perceptual"
    # louder than the input...
    assert np.sqrt(np.mean(y ** 2)) > np.sqrt(np.mean(quiet ** 2))
    # ...but the makeup gain is bounded, so no runaway / non-finite output
    assert np.all(np.isfinite(y))
    assert np.max(np.abs(y)) < 4.0


def test_perceptual_agc_respects_max_gain():
    n = FS // 2
    near_silence = _speech_like(n, seed=2) * 1e-4
    y, info = perceptual_agc(near_silence, FS, max_gain_db=12.0)
    assert info["ran"] is True
    # final gain must not exceed the clamp (allow a hair for smoothing inertia)
    assert info["final_gain_db"] <= 12.0 + 1e-6


def test_perceptual_agc_empty_signal():
    y, info = perceptual_agc(np.zeros(0, dtype=np.float32), FS)
    assert info["ran"] is False


def test_perceptual_agc_no_startup_blast():
    """A clip that OPENS ON SILENCE then speaks must not blast the leading audio
    (the seed-from-first-block bug: silent start → gain slams to the ceiling →
    first word is far louder than the rest)."""
    sil = np.zeros(int(0.4 * FS), dtype=np.float32)        # 400 ms of opening silence
    speech = _speech_like(FS, seed=8) * 0.2
    x = np.concatenate([sil, speech])
    y, info = perceptual_agc(x, FS)
    assert info["ran"] is True
    # The gain must START near where it SETTLES, not pinned to the ceiling.
    assert info["init_gain_db"] <= info["max_gain_db"] - 3.0
    # The first 50 ms of *speech* must not be much louder than the speech body.
    s0 = len(sil)
    head = np.sqrt(np.mean(y[s0:s0 + int(0.05 * FS)] ** 2) + 1e-12)
    body = np.sqrt(np.mean(y[s0 + int(0.2 * FS):] ** 2) + 1e-12)
    assert head <= body * 2.0     # no >6 dB leading-edge overshoot


# ---------------------------------------------------------------------------
#  feedback_risk
# ---------------------------------------------------------------------------
def test_feedback_risk_low_on_speech():
    rep = feedback_risk(_speech_like(FS, seed=3), FS)
    assert rep["ran"] is True
    assert rep["risk"] == "low"


def test_feedback_risk_high_on_sustained_tone():
    n = FS
    t = np.arange(n) / FS
    howl = (0.6 * np.sin(2 * np.pi * 3500.0 * t)).astype(np.float32)
    howl += _speech_like(n, seed=4) * 0.05           # a little background
    rep = feedback_risk(howl, FS)
    assert rep["ran"] is True
    assert rep["risk"] in ("elevated", "high")
    assert "suspect_hz" in rep
    assert abs(rep["suspect_hz"] - 3500.0) < 200.0    # within ~one STFT bin


# ---------------------------------------------------------------------------
#  aec_partitioned
# ---------------------------------------------------------------------------
def test_aec_partitioned_passthrough_without_reference():
    mic = _speech_like(FS // 2, seed=5)
    out, info = aec_partitioned(mic, None, FS)
    assert info["ran"] is False
    np.testing.assert_array_equal(out, mic)            # exact pass-through


def test_aec_partitioned_cancels_delayed_echo():
    n = FS
    far = _speech_like(n, seed=6)                      # loudspeaker reference
    near = _speech_like(n, seed=7) * 0.3              # genuine near-end talker
    # echo = reference delayed and attenuated (a long-ish tail the single tap can't reach)
    delay = 400
    echo = np.zeros(n, dtype=np.float32)
    echo[delay:] = 0.7 * far[:n - delay]
    mic = (near + echo).astype(np.float32)
    out, info = aec_partitioned(mic, far, FS, n_taps=8)
    assert info["ran"] is True
    assert info["n_taps"] == 8
    assert info["erle_db"] > 0.0                       # echo energy reduced
    # residual must be closer to the clean near-end than the echoey mic was
    L = min(len(out), len(near))
    err_in = np.mean((mic[:L] - near[:L]) ** 2)
    err_out = np.mean((out[:L] - near[:L]) ** 2)
    assert err_out < err_in


# ---------------------------------------------------------------------------
#  rtf_drift  (talker-movement detector)
# ---------------------------------------------------------------------------
def test_rtf_drift_single_channel_skips():
    info, moved = rtf_drift(_speech_like(FS)[None, :], FS)
    assert info["ran"] is False
    assert moved is False


def test_rtf_drift_static_source_not_moved():
    """A source fixed at one azimuth → RTF is constant → steady drift ~0."""
    src = _speech_like(2 * FS, seed=11)
    y = _planewave_8ch(src, az_deg=20.0)
    info, moved = rtf_drift(y, FS)
    assert info["ran"] is True
    assert moved is False
    assert info["steady_median"] < 0.02               # essentially no drift


def test_rtf_drift_moving_source_detected():
    """A source swept across azimuth with changing per-mic coupling → SUSTAINED
    RTF drift across blocks → moved=True."""
    src = _speech_like(3 * FS, seed=12)
    segs = np.array_split(src, 6)
    az = np.linspace(-80.0, 80.0, 6)
    rng = np.random.default_rng(5)
    cols = [_planewave_8ch(s, az[k], gains=1.0 + 0.3 * rng.standard_normal(8))
            for k, s in enumerate(segs)]
    y = np.concatenate(cols, axis=1)
    info, moved = rtf_drift(y, FS)
    assert info["ran"] is True
    assert moved is True
    assert info["steady_median"] >= info["move_thresh"]


def test_rtf_drift_separates_static_from_moving():
    """The discriminator must give a wide margin: a moving source's sustained
    drift should dwarf a static source's."""
    static = _planewave_8ch(_speech_like(2 * FS, seed=21), az_deg=10.0)
    segs = np.array_split(_speech_like(2 * FS, seed=22), 6)
    az = np.linspace(-75.0, 75.0, 6)
    moving = np.concatenate([_planewave_8ch(s, az[k]) for k, s in enumerate(segs)], axis=1)
    sm = rtf_drift(static, FS)[0]["steady_median"]
    mm = rtf_drift(moving, FS)[0]["steady_median"]
    assert mm > sm * 10.0


# ---------------------------------------------------------------------------
#  condition_tracking_path  (noise-robust, phase-preserving tracking path)
# ---------------------------------------------------------------------------
def _doa_err(y, true_az):
    """Mean absolute azimuth error (deg) of track_doa vs the true source angle."""
    az = track_doa(y, FS, POLARIS_UCA_M)[0].get("az_per_block", [])
    return float(np.mean([abs(a - true_az) for a in az])) if az else 180.0


def test_condition_tracking_path_shape_and_info():
    y = _planewave_8ch(_speech_like(FS, seed=30), az_deg=0.0)
    yt, info = condition_tracking_path(y, FS)
    assert info["ran"] is True
    assert yt.shape == y.shape
    assert info["band_hz"][0] == 250.0


def test_condition_tracking_preserves_direction_on_clean_source():
    """The common zero-phase band-pass must NOT shift the estimated direction —
    inter-channel phase is preserved, so DOA on a clean source is essentially
    unchanged."""
    y = _planewave_8ch(_speech_like(3 * FS, seed=31), az_deg=15.0)
    yt, _ = condition_tracking_path(y, FS)
    # conditioned DOA stays close to the true 15° (band-pass didn't break phase)
    assert _doa_err(yt, 15.0) < 15.0


def test_condition_tracking_rejects_directional_rumble():
    """A directional low-frequency rumble (ceiling vent at 90°) pulls the raw DOA
    away from the talker; the speech-band tracking path rejects it and points
    much closer to the true direction."""
    import scipy.signal as sps
    n = 3 * FS
    talker = _planewave_8ch(_speech_like(n, seed=11), az_deg=15.0)
    rng = np.random.default_rng(7)
    lo = sps.butter(4, 160, btype="low", fs=FS, output="sos")
    rumble_src = sps.sosfilt(lo, rng.standard_normal(n)).astype(np.float32)
    rumble_src *= 0.6 / (np.std(rumble_src) + 1e-9) * np.std(_speech_like(n, seed=11))
    rumble = _planewave_8ch(rumble_src, az_deg=90.0)
    yn = (talker + rumble).astype(np.float32)
    err_raw = _doa_err(yn, 15.0)
    err_cond = _doa_err(condition_tracking_path(yn, FS)[0], 15.0)
    assert err_cond < err_raw          # conditioning rejects the rumble's pull
    assert err_cond < 15.0             # and lands reasonably near the talker


def test_condition_tracking_keeps_moving_detectable():
    """Conditioning must not suppress genuine movement — a swept source is still
    detected through the speech-band tracking path."""
    segs = np.array_split(_speech_like(3 * FS, seed=32), 6)
    az = np.linspace(-80.0, 80.0, 6)
    rng = np.random.default_rng(9)
    moving = np.concatenate(
        [_planewave_8ch(s, az[k], gains=1.0 + 0.3 * rng.standard_normal(8))
         for k, s in enumerate(segs)], axis=1)
    yt, _ = condition_tracking_path(moving, FS)
    assert rtf_drift(yt, FS)[1] is True
