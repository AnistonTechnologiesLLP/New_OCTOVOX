"""End-to-end smoke test for the 11-stage production pipeline
(:func:`prod_pipeline.run_production`).

There is no other test that drives the whole chain from a WAV on disk to the
clean mono output; the existing suites exercise individual stages. This runs the
full orchestrator on a short synthetic 8-channel plane-wave clip and asserts the
public output contract (return dict + the written file).

It is written to need NO optional neural deps (torch / DeepFilterNet / nara-wpe):
``nr="none"`` skips the neural denoiser and ``beam="batch"`` forces the
data-driven RTF-MVDR (no geometry-dependent movement detectors), so the core CI
matrix (requirements.txt only) can run it. Synthetic + seeded → fast and
deterministic.
"""
from pathlib import Path

import numpy as np
from scipy.io import wavfile

from octovox_app.services.prod_pipeline import run_production
from octovox_app.services.pipeline import POLARIS_UCA_M, SPEED_SOUND

FS = 48000


def _frac_delay(x, ds):
    """Sub-sample delay via FFT phase shift (matches tests/test_prod_ports.py)."""
    n = len(x)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n)
    return np.fft.irfft(X * np.exp(-1j * 2 * np.pi * f * ds), n=n).astype(np.float32)


def _planewave_8ch(src, az_deg):
    """Render a mono source onto the 8-mic Polaris array as a plane wave."""
    direction = np.array([np.cos(np.deg2rad(az_deg)), np.sin(np.deg2rad(az_deg)), 0.0])
    taus = -(POLARIS_UCA_M @ direction) / SPEED_SOUND
    return np.stack([_frac_delay(src, t * FS) for t in taus])


def _synth_8ch(seconds=1.0, az_deg=35.0, seed=0):
    rng = np.random.default_rng(seed)
    n = int(seconds * FS)
    # amplitude-modulated noise burst — a crude speech surrogate with loud/quiet frames
    src = rng.standard_normal(n).astype(np.float32)
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 3.0 * np.arange(n) / FS)
    src = (src * env * 0.1).astype(np.float32)
    y = _planewave_8ch(src, az_deg)                                  # (8, n)
    y += 0.01 * rng.standard_normal(y.shape).astype(np.float32)      # mic self-noise
    return np.clip(y, -1.0, 1.0).astype(np.float32)


def test_run_production_end_to_end(tmp_path):
    y = _synth_8ch()                                                 # (8, n)
    in_path = tmp_path / "synth_8ch.wav"
    wavfile.write(str(in_path), FS, y.T.astype(np.float32))          # (n, 8)
    out_dir = tmp_path / "out"

    res = run_production(str(in_path), str(out_dir),
                         nr="none", beam="batch", dereverb="none",
                         agc="rms", report=False)

    # ---- public return contract ------------------------------------------
    for key in ("clean_path", "clean_name", "stem", "sr", "n_channels",
                "stages", "timings", "elapsed_s"):
        assert key in res, f"missing key {key!r} in result"
    assert res["sr"] == FS
    assert res["n_channels"] == 8
    assert isinstance(res["stages"], dict) and res["stages"]
    assert isinstance(res["timings"], dict) and res["timings"]
    assert res["elapsed_s"] >= 0.0

    # ---- the clean mono file was written and is valid --------------------
    clean = Path(res["clean_path"])
    assert clean.is_file()
    fs_out, data = wavfile.read(str(clean))
    assert fs_out == FS
    assert data.ndim == 1                                            # mono
    assert data.size > 0
    assert np.isfinite(data.astype(np.float64)).all()
