"""
OM-LSA NR ("near-DFN, no DF3") A/B evaluation on REAL recordings.

Runs the production pipeline end-to-end with each NR engine and compares, on the
*final clean output* of each mode:

  · noise BED  — RMS of the quietest 20% of 30 ms windows (the pauses; lower is
                 more suppression). Because stage [10] AGC normalises loudness,
                 the VOICE level is ~equal across modes, so a lower bed at equal
                 voice means a better output SNR — a fair cross-mode comparison.
  · voice      — RMS of the loudest 20% of windows (should stay ~constant).
  · output SNR — 20·log10(voice/bed) (higher is better).
  · NR runtime — timings["nr"] (ms) and TOTAL elapsed (the speed goal: omlsa
                 must be clearly cheaper than dfn).

Engines: dfn (if installed), omlsa, omlsa+CFAR, fast, none.

Run:
  $env:OCTOVOX_FORCE_CPU="1"
  c:/Work/New_OCTOVOX/.venv311/Scripts/python.exe c:/Work/New_OCTOVOX/tools/omlsa_eval.py
"""
import os, sys, time
os.environ.setdefault("OCTOVOX_FORCE_CPU", "1")

ROOT = r"c:\Work\New_OCTOVOX"
sys.path.insert(0, ROOT)

import numpy as np
from scipy.io import wavfile

import octovox_app.services.pipeline as p
import octovox_app.services.prod_pipeline as prod

EPS = p.EPS
FS = p.FS_REQUIRED
INDIR = os.path.join(ROOT, "data", "input")
OUTDIR = os.path.join(ROOT, "data", "output")

# A representative spread: clean single talker, non-stationary (knock), two-talker,
# and a noisy office. Edit freely — any 8-ch 48 kHz clip in data/input works.
CLIPS = [
    "conference_room_single_person.wav",
    "Conference_room_sitting_take2_with_knock.wav",
    "Conference_room_two_person_talk.wav",
    "MAIN_OFFICE.wav",
]

# (label, nr, force_cfar)  — force_cfar=None leaves the env default (off).
ENGINES = [
    ("dfn",       "dfn",   None),
    ("omlsa",     "omlsa", False),
    ("omlsa+cfar","omlsa", True),
    ("fast",      "fast",  None),
    ("none",      "none",  None),
]


def _read_mono(path):
    fs, a = wavfile.read(path)
    if np.issubdtype(a.dtype, np.integer):
        a = a.astype(np.float64) / float(np.iinfo(a.dtype).max)
    a = a.astype(np.float64)
    if a.ndim > 1:
        a = a.mean(axis=1)
    return a, fs


def _windows_rms(sig, fs):
    w = max(1, int(0.03 * fs))
    e = [float(np.sqrt(np.mean(sig[i:i + w] ** 2)))
         for i in range(0, max(1, len(sig) - w), w)]
    return np.asarray(e) if e else np.asarray([EPS])


def _bed_voice_db(sig, fs):
    e = _windows_rms(sig, fs)
    bed = float(np.percentile(e, 20)) + EPS
    voice = float(np.percentile(e, 90)) + EPS
    return 20 * np.log10(bed), 20 * np.log10(voice), 20 * np.log10(voice / bed)


def run_clip(name):
    path = os.path.join(INDIR, name)
    if not os.path.exists(path):
        print(f"  ! missing {name}"); return None
    print(f"\n=== {name} ===")
    print(f"  {'engine':<11}{'bed dBFS':>10}{'voice dBFS':>12}{'out SNR':>10}{'nr ms':>9}{'total s':>9}  {'ran/engine'}")
    base = None
    for label, nr, force_cfar in ENGINES:
        tok = None
        if force_cfar is not None:
            tok = p.set_cfar_mask(force_cfar)
        try:
            t0 = time.perf_counter()
            r = prod.run_production(path, OUTDIR, nr=nr, report=False)
            wall = time.perf_counter() - t0
        except Exception as e:
            print(f"  {label:<11}  ERROR: {e}")
            if tok is not None: p.reset_cfar_mask(tok)
            continue
        if tok is not None:
            p.reset_cfar_mask(tok)
        clean_path = os.path.join(OUTDIR, r["stem"], r["clean_name"])
        sig, _ = _read_mono(clean_path)
        bed, voice, snr = _bed_voice_db(sig, FS)
        nr_ms = r["timings"].get("nr")
        eng = r["stages"].get("noise_reduction", {})
        engine = eng.get("engine", "—")
        ran = "ran" if eng.get("ran") else "skip"
        if label == "omlsa":
            base = dict(bed=bed, snr=snr, nr_ms=nr_ms or 0.0)
        print(f"  {label:<11}{bed:>10.1f}{voice:>12.1f}{snr:>10.1f}"
              f"{(nr_ms or 0):>9.0f}{r['elapsed_s']:>9.2f}  {ran}/{engine}")
    # quick verdict vs dfn for this clip
    return base


def main():
    print(f"OM-LSA eval | FS={FS} | HAS_DFN={p.HAS_DFN} HAS_VAD={p.HAS_VAD} "
          f"| CFAR default={p._CFAR_MASK}")
    print("Lower bed dBFS = more suppression; higher out SNR = better; "
          "omlsa nr-ms should be << dfn nr-ms.")
    for c in CLIPS:
        run_clip(c)
    print("\nGuidance: omlsa should land between 'fast' and 'dfn' on out-SNR, "
          "well under dfn on nr-ms, and omlsa+cfar should NOT beat omlsa on real\n"
          "speech (CFAR is a measured regression — kept off by default).")


if __name__ == "__main__":
    main()
