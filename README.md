# OCTOVOX

> 8-channel speech front-end for the **sensiBel SB-POLARIS** optical MEMS array.
> An 11-stage **production voice pipeline** turns 8 raw mic channels into one clean
> mono voice — fast, in a fraction of real-time.

The app's primary path is the **production clean-voice pipeline**
(`/api/clean` → `prod_pipeline.run_production`): a conferencing / ceiling-array
DSP chain (calibration → high-pass → VAD → DOA/tracking → MVDR beamforming → AEC
→ noise reduction → automix → AGC/EQ/limiter) that emits one clean WAV. The
6-algorithm bootstrap **instrument** that earlier versions surfaced in the UI
still lives on in [`pipeline.py`](octovox_app/services/pipeline.py) and is reused
wholesale by the production path — its beamformers, RTF estimators, post-filters
and DeepFilterNet wrapper are the building blocks of the clean-voice chain.

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
│   │   ├── prod_pipeline.py   # PRODUCTION clean-voice pipeline (/api/clean) — main path
│   │   ├── clean_cascade.py   # shared I/O + beamformers + neural wrappers
│   │   ├── pipeline.py        # DSP / beamforming instrument library (was octovox.py)
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

The UI has three racks:

1. **01 · Source** — record live, drop a `.wav`, or generate a synthetic sample.
2. **02 · Files** — pick a recording and the pipeline controls (below), then
   **analyse** to clean the voice.
3. **03 · Console** — A/B the raw 8-ch downmix against the clean output, and read
   the **per-stage ran/skip + timing** table (every stage reports itself, so a
   skipped stage is never silent).

### Production pipeline stages

Each `/api/clean` run drives `prod_pipeline.run_production`. Dereverb has two
engines: **spectral** (fast, single-channel, runs on the mono beam) and **WPE**
(multichannel, runs as a front-end before the beam — the principled but ~3×
real-time spot).

| # | Stage | Notes |
|---|-------|-------|
| 1 | Mic capsules | the 8 WAV channels |
| 1b | **Mic health** | per-capsule OK / WARN / FAULT / DEAD / CLIP diagnostic (read-only) |
| 2 | Channel calibration | equalize per-mic sensitivity to the array median |
| 3 | High-pass + noise-floor estimate | zero-phase HPF (HVAC rumble) |
| 5·track | **Tracking-path conditioning** | noise-robust, phase-preserving speech-band copy of the array for the trackers only (audio path untouched) |
| 4 | VAD / speech detector | Silero |
| 5 | DOA / talker tracking | block-wise SRP-PHAT (azimuth readout) |
| 5b | **Movement selector** | SRP-PHAT spread *or* **RTF drift** (ambiguity-free; auto-switches batch↔tracked) |
| 6 | Beamforming 8→1 | batch / tracked RTF-MVDR (+ downmix blend) |
| 7 | AEC (far-end ref) | **partitioned** multi-tap or single-tap NLMS (active only with a reference WAV) |
| 7b | **Feedback / howl risk** | sustained-tone diagnostic (read-only) |
| 8 | Noise reduction | DeepFilterNet3 / decision-directed Wiener / none |
| 9 | Automix / gating | VAD silence-floor on the single beam |
| 10 | **AGC** + EQ + limiter | **perceptual** (attack/release + K-weighting) or instantaneous RMS |
| 11 | Output | clean mono WAV (+ device playout via `/api/playout`) |

**Bold** stages were added recently (see `CHANGES.md`).

### Controls (rack 02)

| Control | Options | What it does |
|---------|---------|--------------|
| Noise reduction | DeepFilterNet3 · fast (dd-Wiener) · none | stage 8 engine |
| Beam | auto · batch · tracked | stage 6 beamformer |
| Movement | SRP-PHAT · RTF drift | which signal decides batch-vs-tracked in `auto` |
| AGC | perceptual · RMS | stage 10 loudness control |
| AEC | partitioned · single-tap | stage 7 echo canceller (needs a reference WAV) |
| Noise-robust tracking | on / off | the tracking-path conditioner (5·track) |
| Dereverb | none · spectral · WPE | spectral = fast single-channel late-reverb suppressor (~0.02× RT); WPE = multichannel front-end (~3× RT). Off by default |
| EQ | on / off | gentle speech-presence EQ |

> **Note on tracking & beam-weighting.** The "noise-robust tracking" split is the
> transferable idea from ceiling-array products (Biamp Parlé et al.): the
> *tracking* signal is speech-band and noise-robust so HVAC/projector noise can't
> steer the beam, while the *audio* signal is untouched. It is **not** a latency
> feature (parallel paths don't halve latency; this pipeline is offline batch).
> Multi-beam "beam weighting / anti-collision" does not apply here — OCTOVOX
> forms a single MVDR beam, so there are no two beams to deconflict.

### The instrument (reused under the hood)

The 6-algorithm bootstrap competition (Single-mic, RTF-MVDR, RTF-GEV+BAN, MWF,
SDW-MWF, tracked RTF-MVDR) still lives in `pipeline.py`. Each output is sliced
into ~30 ms loud/quiet windows; 500 bootstrap iterations build a per-algorithm
SNR distribution and the highest-median-SNR algorithm wins, with its lead-share
as a **consistency** score. The production path reuses these beamformers, RTF
estimators and post-filters directly. See
[`RTF_MVDR_TRACKED.md`](RTF_MVDR_TRACKED.md) for the batch-vs-tracked beamformer math.

---

## Files saved per recording

```
data/output/<recording_stem>/
  ├── clean_prod.wav            # the clean mono voice (production path output)
  ├── input_mono.wav            # raw 8-ch downmix, for A/B comparison
  ├── report.html               # standalone report (open in any browser — see below)
  ├── visualization.png         # 4-panel figure embedded in the report
  └── …                         # extra instrument outputs only if the instrument is run
```

### Report

Every clean run writes a self-contained **`report.html`** (the **📄 Report**
button in the console opens it; `/api/clean` also returns its URL). It embeds
everything inline so the single file is portable: raw-vs-clean A/B players, a KPI
strip (levels, noise-floor before→after, engines, process time), a 4-panel
visualization (waveforms, raw & clean spectrograms, per-mic health bars), the
diagnostics (mic-health table, DOA/movement, feedback risk, noise floor), and the
full per-stage ran/skip + timing table.

---

## CLI

The DSP pipeline can still be driven directly:

```bash
python -m octovox_app.services.pipeline --wav data/input/rec.wav --geometry uca_polaris_40mm
```

---

## License

Research / evaluation. Algorithm references are in the source as docstrings.
