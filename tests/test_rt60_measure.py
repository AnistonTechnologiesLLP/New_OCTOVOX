"""
Tests for blind RT60 estimation (``rt60_measure.measure_rt60``).

Uses synthetic recordings: noise bursts (source on/off) convolved with an
exponential-decay RIR of a *known* T60, so the estimator has real free decays to
fit. Blind estimation is approximate, so tolerances are generous — the mid bands
(500–2000 Hz), where octave filtering is well-conditioned, are checked tightest.
"""
import numpy as np
import pytest

from octovox_app.services.rt60_measure import measure_rt60, OCTAVE_BANDS

FS = 48000


def _exp_rir(t60, fs=FS, seed=0):
    """Noise-like RIR whose energy reaches −60 dB exactly at ``t60`` seconds."""
    n = int(1.5 * t60 * fs)
    # amplitude exp(-6.908 t / T60) ⇒ energy (²) is −60 dB at t = T60.
    h = np.exp(-6.908 * np.arange(n) / (t60 * fs)).astype(np.float64)
    h *= np.random.default_rng(seed).standard_normal(n)
    h[0] = 1.0
    return h


def _recording(t60, seed=1, fs=FS):
    """0.4 s noise bursts + 0.8 s gaps, reverberated — gives clean free decays."""
    rng = np.random.default_rng(seed)
    src = np.zeros(int(6 * fs))
    for k in range(4):
        a = int((k * 1.2 + 0.05) * fs)
        b = a + int(0.4 * fs)
        src[a:b] = rng.standard_normal(b - a)
    y = np.convolve(src, _exp_rir(t60, fs))[: len(src)]
    return y / (np.max(np.abs(y)) + 1e-9)


def _mid_bands(res):
    return [b["rt60"] for b in res["bands"] if b["band"] in (500, 1000, 2000) and b["rt60"] is not None]


def test_schema_and_bands():
    res = measure_rt60(_recording(0.6), FS)
    assert set(res) >= {"ran", "bands", "overall_rt60", "n_decays", "method"}
    assert [b["band"] for b in res["bands"]] == list(OCTAVE_BANDS)
    assert res["ran"] is True


def test_recovers_known_t60_mid_bands():
    res = measure_rt60(_recording(0.6), FS)
    mids = _mid_bands(res)
    assert len(mids) >= 2, "expected mid-band estimates"
    for rt in mids:
        assert rt == pytest.approx(0.6, abs=0.15), f"mid-band RT60 {rt} far from 0.6"


def test_monotonic_with_true_t60():
    short = measure_rt60(_recording(0.4), FS)["overall_rt60"]
    long = measure_rt60(_recording(0.9), FS)["overall_rt60"]
    assert short is not None and long is not None
    assert long > short, f"expected longer T60 to read higher ({long} vs {short})"


def test_overall_in_range():
    res = measure_rt60(_recording(0.6), FS)
    assert res["overall_rt60"] == pytest.approx(0.6, abs=0.2)
    assert res["n_decays"] > 0


def test_silence_has_no_decays():
    res = measure_rt60(np.zeros(int(3 * FS)), FS)
    assert res["ran"] is False
    assert res["overall_rt60"] is None


def test_too_short_recording():
    res = measure_rt60(np.random.default_rng(0).standard_normal(int(0.1 * FS)), FS)
    assert res["ran"] is False
    assert "short" in res.get("reason", "")
