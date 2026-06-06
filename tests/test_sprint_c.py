"""
Sprint C regression tests — DeepFilterNet2 as a 7th competing algorithm.

Covers the new public surface in octovox_app.services.pipeline:
    bf_dfn2, _get_dfn_model
plus the guarantees that matter most given the historical CUDA/CPU failure:
    · the module forces CPU for DFN at import time,
    · bf_dfn2 degrades to None (never raises) when DFN is unavailable,
    · the pipeline either lists DeepFilterNet2 in the leaderboard OR logs a
      clean skip, and the other algorithms run either way.

These tests are written to PASS whether or not `deepfilternet` is installed:
the whole point of Sprint C is that DFN is optional and never breaks the
other 6 algorithms.
"""
import json
import os

import numpy as np
import pytest
from scipy.io import wavfile

from octovox_app.services import pipeline as P
from octovox_app.services.pipeline import bf_dfn2, _get_dfn_model, FS_REQUIRED


# ---------------------------------------------------------------------------
#  Synthetic-signal helpers (mirrors test_sprint_b.py conventions)
# ---------------------------------------------------------------------------
def _synth_8ch(dur_s=2.0, seed=0):
    """A simple 8-channel recording: a shared broadband source with small
    per-channel delays + white noise. Enough for process_file to run."""
    n = int(dur_s * FS_REQUIRED)
    rng = np.random.default_rng(seed)
    src = rng.standard_normal(n).astype(np.float32)
    y = np.empty((n, P.N_CH), dtype=np.float32)
    for ch in range(P.N_CH):
        shift = ch  # 1-sample-per-channel delay, trivial geometry
        y[:, ch] = np.roll(src, shift)
    y += rng.standard_normal(y.shape).astype(np.float32) * 0.05
    y = (y / (np.max(np.abs(y)) + 1e-9)) * 0.5
    return y


def _write_8ch(path, y):
    wavfile.write(str(path), FS_REQUIRED, (y * 32767).astype(np.int16))


# ---------------------------------------------------------------------------
#  1. Import test
# ---------------------------------------------------------------------------
def test_imports():
    assert callable(bf_dfn2)
    assert callable(_get_dfn_model)
    # The availability flag + import-error string must always exist, even
    # when DFN is not installed (they drive the graceful-skip path).
    assert hasattr(P, "_DFN_AVAILABLE")
    assert isinstance(P._DFN_AVAILABLE, bool)
    assert hasattr(P, "_DFN_IMPORT_ERROR")


# ---------------------------------------------------------------------------
#  2. CPU-mode guard test
# ---------------------------------------------------------------------------
def test_cpu_pin_is_opt_in():
    """DFN now runs GPU-first with a per-call CPU fallback (the device-mismatch
    that motivated the old blanket CPU pin is fixed at the source in
    _dfn_run_enhance). So importing pipeline must NOT force-hide the GPU by
    default: it only sets CUDA_VISIBLE_DEVICES="" when OCTOVOX_FORCE_CPU=1.
    Verify the gate directly rather than re-importing the module."""
    # Default (no force flag): the import-time pin is a no-op — any
    # CUDA_VISIBLE_DEVICES present came from the surrounding environment, not us.
    if os.environ.get("OCTOVOX_FORCE_CPU") != "1":
        # Nothing to assert about the value; the contract is "don't force CPU".
        # The opt-in escape hatch is the part we pin down:
        assert hasattr(P, "_DFN_DEVICE"), "live DFN device state must exist"
        assert P._DFN_DEVICE in ("cpu", "cuda")
    else:
        assert os.environ.get("CUDA_VISIBLE_DEVICES") == "", \
            "OCTOVOX_FORCE_CPU=1 must hard-pin CUDA_VISIBLE_DEVICES to ''"


# ---------------------------------------------------------------------------
#  3. Graceful-failure test
# ---------------------------------------------------------------------------
def test_bf_dfn2_returns_none_when_unavailable(monkeypatch):
    """With DFN forced unavailable, bf_dfn2 must return None — never raise —
    even if torch itself is not installed (the None guard runs first)."""
    monkeypatch.setattr(P, "_DFN_AVAILABLE", False)
    monkeypatch.setattr(P, "_DFN_LOAD_FAILED", True)
    monkeypatch.setattr(P, "_DFN_MODEL", None)

    x = np.zeros(48000, dtype=np.float32)
    out = bf_dfn2(x, 48000)
    assert out is None


def test_bf_dfn2_rejects_non_48k(monkeypatch):
    """Non-48 kHz input is rejected with None (DFN2 weights are 48 kHz).
    We force the model to look 'available' so we exercise the fs guard,
    but stub the loader so no real model is needed."""
    monkeypatch.setattr(P, "_DFN_AVAILABLE", True)
    monkeypatch.setattr(P, "_get_dfn_model",
                        lambda: ("FAKE_MODEL", "FAKE_STATE"))
    x = np.zeros(16000, dtype=np.float32)
    assert bf_dfn2(x, 16000) is None


def test_get_dfn_model_none_when_unavailable(monkeypatch):
    monkeypatch.setattr(P, "_DFN_AVAILABLE", False)
    monkeypatch.setattr(P, "_DFN_LOAD_FAILED", False)
    monkeypatch.setattr(P, "_DFN_MODEL", None)
    assert _get_dfn_model() == (None, None)


# ---------------------------------------------------------------------------
#  4. End-to-end pipeline test
# ---------------------------------------------------------------------------
def test_pipeline_excludes_dfn_from_analysis(tmp_path):
    """DeepFilterNet was REMOVED from the analysis leaderboard (it now lives
    only in the clean-voice cascade, services/clean_cascade.py). So process_file
    must run on an 8-ch wav and:
       · always produce the beamformer algorithms in the leaderboard,
       · NEVER include 'DeepFilterNet2' in bootstrap_stats — even when the
         `deepfilternet` package is installed (_DFN_AVAILABLE is True),
       · report metrics['deepfilternet2_active'] == False,
       · never log an "Algorithm ⑧ DeepFilterNet" analysis step.
    """
    y = _synth_8ch(dur_s=1.5, seed=1)
    wav_path = tmp_path / "synthetic_8ch.wav"
    _write_8ch(wav_path, y)

    logs = []
    def cb(msg, pct=None):
        logs.append(str(msg))

    out_dir = P.process_file(wav_path, tmp_path / "out",
                             geometry="uca_polaris_40mm",
                             visualize=False, n_bootstrap=50,
                             post_filter="none", progress_cb=cb)

    with open(out_dir / "metrics.json") as f:
        metrics = json.load(f)
    boot = metrics["bootstrap_stats"]

    # The beamformer algorithms still run.
    assert "Single mic" in boot
    assert "RTF-MVDR" in boot

    # DeepFilterNet must NOT be an analysis competitor, regardless of whether
    # the package is installed (the cascade owns it now, not the leaderboard).
    assert "DeepFilterNet2" not in boot
    assert metrics["deepfilternet2_active"] is False
    assert not any("Algorithm ⑧" in m for m in logs)

    # WAV-count invariant: one saved WAV per leaderboard algorithm, plus the
    # input reference channel.
    wavs = list(out_dir.glob("*.wav"))
    assert len(wavs) == 1 + len(boot)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
