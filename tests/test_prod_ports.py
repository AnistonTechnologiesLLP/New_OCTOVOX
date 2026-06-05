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
    mic_health_report, perceptual_agc, feedback_risk, aec_partitioned,
)

FS = 48000


def _speech_like(n, seed=0):
    """A non-stationary, band-limited noise burst — a crude speech surrogate."""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n).astype(np.float32)
    # amplitude-modulate so there are loud and quiet frames (for VAD/AGC logic)
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 3.0 * np.arange(n) / FS)
    return (x * env * 0.1).astype(np.float32)


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
