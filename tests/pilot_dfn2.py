#!/usr/bin/env python3
"""
Sprint C — DeepFilterNet2 pilot / sandbox (Step 1, MANDATORY before wiring).

Runs DeepFilterNet2 end-to-end on a tiny synthetic 1-channel 48 kHz WAV,
completely outside the OCTOVOX pipeline, to prove the CPU-forcing strategy
works on THIS machine before we trust it in pipeline.py.

Why this exists: a previous integration (the "OCTOVOX-MAX" polish step)
failed three times on a CUDA-equipped Windows laptop — enhance() pushed CPU
audio onto the GPU and crashed with a tensor-device mismatch. The fix here
is structural, not a monkey-patch:

  1. Force CPU at the ENVIRONMENT level (CUDA_VISIBLE_DEVICES="") BEFORE
     torch is ever imported — done at the very top of this file.
  2. Force CPU at the DFN CONFIG level (DEVICE=cpu) before init_df().
  3. Wrap enhance() in try/except so a device mismatch is reported, not
     swallowed.

Run:   python tests/pilot_dfn2.py
Exit code 0 = pilot passed; non-zero = pilot failed (do NOT proceed to
Step 2 — diagnose first).
"""
import os
import sys
import tempfile
import traceback

# ── Belt #1: hide every GPU from torch BEFORE it is imported anywhere. ──
# Setting this here (top of the process, before `import torch`) is what
# makes it actually effective — once torch initialises CUDA, a later set
# is ignored.
os.environ["CUDA_VISIBLE_DEVICES"] = ""

import numpy as np
import torch


def _write_wav(path, data, sr):
    """Write a mono float32 WAV. Prefer soundfile; fall back to scipy."""
    try:
        import soundfile as sf
        sf.write(path, data, sr)
        return "soundfile"
    except Exception:
        from scipy.io import wavfile
        wavfile.write(path, sr, data.astype(np.float32))
        return "scipy"


def _read_wav(path):
    try:
        import soundfile as sf
        d, sr = sf.read(path, dtype="float32")
        return d, sr
    except Exception:
        from scipy.io import wavfile
        sr, d = wavfile.read(path)
        return d.astype(np.float32), sr


def main():
    print("=" * 64)
    print("  DeepFilterNet2 pilot — Sprint C, Step 1")
    print("=" * 64)
    print(f"  torch {torch.__version__}  ·  CUDA_VISIBLE_DEVICES="
          f"{os.environ.get('CUDA_VISIBLE_DEVICES')!r}  ·  "
          f"cuda.is_available()={torch.cuda.is_available()}")

    # ── Synthetic 2-second 440 Hz tone + white noise, 48 kHz mono. ──
    sr = 48000
    t = np.linspace(0, 2.0, sr * 2, endpoint=False)
    noisy = (np.sin(2 * np.pi * 440 * t) * 0.3 +
             np.random.randn(len(t)) * 0.05).astype("float32")

    tmpdir = tempfile.gettempdir()
    in_path = os.path.join(tmpdir, "dfn_test_in.wav")
    out_path = os.path.join(tmpdir, "dfn_test_out.wav")
    backend = _write_wav(in_path, noisy, sr)
    print(f"  wrote synthetic input via {backend}: {in_path} "
          f"({len(noisy)} samples)")

    # ── Belt #2: force CPU at the DFN config level before init_df(). ──
    # Documented in the DFN README as the correct way to disable CUDA.
    # We do NOT monkey-patch get_device() — that approach failed 3× before.
    try:
        from df.config import config as df_config
        df_config.set("DEVICE", "cpu", str, section="train")
        print("  set DFN config [train] DEVICE=cpu")
    except Exception as e:
        print(f"  [info] DFN config DEVICE override skipped ({e}); "
              f"relying on CUDA_VISIBLE_DEVICES + model.cpu()")

    from df.enhance import enhance, init_df

    print("  init_df() — downloads default model on first call …")
    model, df_state, _ = init_df()
    try:
        model = model.cpu()
    except Exception as e:
        print(f"  [info] model.cpu() skipped ({e})")
    print(f"  model loaded; df_state.sr() = {df_state.sr()}")

    # ── enhance ──
    audio_t = torch.from_numpy(np.ascontiguousarray(noisy)).unsqueeze(0)
    with torch.no_grad():
        enhanced = enhance(model, df_state, audio_t)
    out = enhanced.squeeze(0).detach().cpu().numpy().astype("float32")
    _write_wav(out_path, out, sr)

    # ── Verify output is sensible. ──
    ok = True
    def check(label, cond):
        nonlocal ok
        print(f"    {'PASS' if cond else 'FAIL'}  {label}")
        ok = ok and cond

    print("  verifying output:")
    check(f"length within 1 frame of input "
          f"(in={len(noisy)}, out={len(out)})",
          abs(len(out) - len(noisy)) <= 480)          # ~1 frame @48k/10ms
    check("not all zeros", float(np.max(np.abs(out))) > 0.0)
    check("no NaN/Inf", bool(np.all(np.isfinite(out))))
    check(f"48 kHz round-trip", _read_wav(out_path)[1] == 48000)

    print("=" * 64)
    if ok:
        print(f"  DFN pilot SUCCEEDED; output saved to {out_path}")
        print("=" * 64)
        return 0
    print("  DFN pilot FAILED a sanity check (see above).")
    print("=" * 64)
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("\n" + "=" * 64)
        print("  DFN pilot CRASHED — full traceback below.")
        print("  If this is a 'cuda'/'CPU' tensor-device mismatch, STOP and")
        print("  diagnose: do NOT proceed to Step 2 (pipeline integration).")
        print("=" * 64)
        traceback.print_exc()
        sys.exit(2)
