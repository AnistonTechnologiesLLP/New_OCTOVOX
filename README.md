# OCTOVOX

> 8-channel speech extraction studio for the **sensiBel SB-POLARIS** optical MEMS array.
> Six beamformers compete on every recording; a 500-iteration bootstrap picks the consistent winner.

This is the **package-first** rebuild of OCTOVOX. The DSP pipeline, web UI, API,
and behaviour are unchanged from the original flat layout — only the project
structure has been reorganized into a maintainable, runnable Flask package.

---

## Project layout

```
New_OCTOVOX/
├── run.py                     # top-level launcher (app-factory entrypoint)
├── requirements.txt
├── README.md
├── octovox_app/               # the Flask application package
│   ├── __init__.py            # create_app() app-factory
│   ├── config.py              # paths (input/output/uploads) + server config
│   ├── routes/
│   │   ├── pages.py           # "/" and "/output/<path>" file serving
│   │   └── api.py             # all "/api/..." endpoints
│   ├── services/
│   │   ├── pipeline.py        # DSP / beamforming pipeline (was octovox.py)
│   │   └── verdicts.py        # cross-recording aggregation (was verdict.py)
│   ├── utils/
│   │   ├── audio.py           # WAV metadata (wav_info)
│   │   ├── files.py           # filename / path-traversal safety
│   │   └── jobs.py            # in-memory job registry for poll endpoints
│   ├── templates/             # index.html
│   └── static/                # app.js, style.css, assets/, uploads/
└── data/
    ├── input/                 # sample WAV recordings (8 ch @ 48 kHz)
    └── output/                # generated per-recording results (starts empty)
```

Templates and static assets live inside the package so Flask resolves them from
the app location. Runtime data lives under `data/`; `data/output/` is created
empty and populated by the app — old generated results are not carried over.

---

## Install

```bash
# 1) Linux only — PortAudio for sounddevice
sudo apt install -y libportaudio2

# 2) Python deps
pip install -r requirements.txt

# 3) Optional: DeepFilterNet / nara-wpe for the neural SOTA slot
pip install deepfilternet nara-wpe torch torchaudio
```

## Run

```bash
cd New_OCTOVOX
python run.py
# open http://127.0.0.1:5050
```

`run.py` builds the app via `octovox_app.create_app()` — no `sys.path` hacks and
no dependency on the old repo root.

---

## How it works

1. **Step 01** — Record live, drop a `.wav`, or generate a synthetic sample.
2. **Step 02** — Pick array geometry (UCA Polaris is the default), post-filter,
   and toggle DeepFilterNet if installed. Click **Run pipeline**.
3. **Step 03** — Read the **winner banner** (algorithm + consistency %), browse
   the algorithm leaderboard, and play each output to compare.

Six beamformers (Single-mic, RTF-MVDR, RTF-GEV+BAN, MWF, SDW-MWF, MaxSNR+Wiener)
run in parallel on every recording. Each output is sliced into ~30 ms windows
labelled loud/quiet against the input envelope; 500 bootstrap iterations build a
per-algorithm SNR distribution, and the algorithm with the highest median SNR
wins. The share of iterations it led is the **consistency** score.

---

## Files saved per recording

```
data/output/<recording_stem>/
  ├── 01_Single_mic.wav
  ├── 02_RTF-MVDR.wav
  ├── 03_RTF-GEV_BAN.wav
  ├── 04_MWF.wav
  ├── 05_SDW-MWF_mu2.wav
  ├── 06_MaxSNRWiener.wav
  ├── 07_octovox_max.wav        (only if DeepFilterNet ran)
  ├── visualization.png
  ├── report.html               (standalone, open in any browser)
  └── metrics.json              (raw numbers, bootstrap stats, DoA, etc.)
```

---

## CLI

The DSP pipeline can still be driven directly:

```bash
python -m octovox_app.services.pipeline --wav data/input/rec.wav --geometry uca_polaris_40mm
```

---

## License

Research / evaluation. Algorithm references are in the source as docstrings.
