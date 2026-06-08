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
| 5 | DOA / talker tracking | block-wise SRP-PHAT (azimuth readout — **opt-in diagnostic**; front/back ambiguous on this UCA so it never steers the beam) |
| 5b | **Movement selector** | SRP-PHAT spread *or* **RTF drift** (ambiguity-free; auto-switches batch↔tracked). Runs only when it can change the beam (`beam=auto`) |
| 6 | Beamforming 8→1 | batch / tracked RTF-MVDR (+ downmix blend). **Default `auto`** = batch (cheaper *and* higher-SNR on most clips), switching to tracked only on sustained movement. **When `target_az` is set**: replaced by `extract_direction` — direction-masked MVDR that keeps the chosen talker and nulls the rest (competitive spectral post-filter adds low-frequency rejection). Interferer azimuths are detected automatically or supplied from `/api/speakers` |
| 7 | AEC (far-end ref) | **partitioned** multi-tap or single-tap NLMS (active only with a reference WAV) |
| 7b | **Feedback / howl risk** | sustained-tone diagnostic (read-only) |
| 8 | Noise reduction | DeepFilterNet3 (default 32 dB cap) / decision-directed Wiener / none |
| 8c | **Residual suppressor** | gentle 2nd pass that mops up the stationary hiss/hum DFN3 leaves behind (over-subtraction Wiener keyed on the pause-frame noise PSD) |
| 9 | Automix / gating | VAD silence-floor on the single beam (default −40 dB) |
| 10 | **AGC** + EQ + limiter | **perceptual** (attack/release + K-weighting) or instantaneous RMS |
| 11 | Output | clean mono WAV (+ device playout via `/api/playout`) |

**Bold** stages were added recently (see `CHANGES.md`).

### Controls (rack 02)

| Control | Options | What it does |
|---------|---------|--------------|
| **Target speaker** | ⊕ Detect chips · click-to-aim radar | Two ways to pick "whose voice": **⊕ Detect** scans the recording with SRP-PHAT (`/api/speakers`) and shows a chip per direction (a clean run also auto-detects), or **click the radar** to aim the beam at any direction by hand (snaps to a nearby detected talker within 8°). Either routes stage [6] through `extract_direction` (direction-masked RTF-MVDR) — only that talker comes out. Click the active chip or × Clear to go back to all voices. **Accuracy note:** on the 40 mm array this isolates **outer talkers cleanly (~+13–15 dB) but a talker flanked on both sides only ~+2–5 dB** — the array's angular-resolution floor. Detected angles carry a ~10° inward bias, but extraction tolerates a few degrees, so picking the nearest chip — or nudging the radar by ear — still works. |
| **Preset** | **Quality** · Fast · Custom | one-click profiles. **Quality** (default) = the full DFN3 chain below, output unchanged. **Fast** = lowest runtime (`nr=fast`, `beam=batch` so the movement detectors are skipped, `mask=coherence`, lighter residual) — **~0.33× real-time vs ~0.44× for Quality**. Touching any knob flips to Custom |
| Noise reduction | DeepFilterNet3 · fast (dd-Wiener) · none | stage 8 engine (DFN3 capped at 32 dB). **Default DFN3** |
| Denoise strength | 0 … 1 slider (default 0.6) | stage 8c residual mop-up — 0 = off, ~0.3 gentle, 0.6 natural, 1.0 near-silent bed |
| Beam | **auto** · batch · tracked | stage 6 beamformer. **Default `auto`** — batch on static clips (cheaper + higher-SNR, and the only path the Mask applies to), tracked only on sustained movement |
| Movement | SRP-PHAT · RTF drift | which signal decides batch-vs-tracked in `auto` (default **RTF drift**). Runs only when `beam=auto` |
| Mask | SNR · coherence-auto · coherence | speech/noise mask for the MVDR covariance; coherence adds the spatial (ASA) cue. **`auto`** (default) builds both beams and keeps the better — never worse than baseline. Affects the batch beam only |
| AGC | perceptual · **RMS** | stage 10 loudness control (default **RMS**, instantaneous) |
| AEC | partitioned · single-tap | stage 7 echo canceller (active only with an AEC reference, below) |
| AEC reference | None · ‹input file› | the far-end loudspeaker feed for echo cancellation. **None (default)** = AEC is a pass-through; pick a file to engage stage 7 |
| Noise-robust tracking | on / off | the tracking-path conditioner (5·track) |
| Dereverb | none · spectral · WPE | spectral = fast single-channel late-reverb suppressor (~0.02× RT); WPE = multichannel front-end (~3× RT). Off by default |
| EQ | on / off | gentle speech-presence EQ |
| **Generate report** | on / **off** | stage [report] HTML + matplotlib figure. **Off by default** so the 200–700 ms render is opt-in (it's not needed for the clean WAV) |
| **Advanced** (collapsible) | sliders + toggles | off-axis blend (`mvdr_blend`, default 0.6 — higher keeps more of the off-axis speakers), DFN cap (`dfn_atten_lim_db`, default 32 dB), pause floor (`pause_floor_db`, default −40 dB), a DOA azimuth readout toggle (`doa_readout`, diagnostic), and a **CFAR adaptive noise floor** toggle (`cfar`, **experimental, default off**). All optional overrides of the API defaults |
| **CFAR adaptive noise floor** | on / **off** (Advanced) | swaps the speech mask's static whole-clip 10th-percentile noise floor for a **local, time-varying** CA-CFAR estimate (`cfar_local_floor`) — helps under **non-stationary** noise (HVAC swells, fans, knocks) by stopping noise bursts from being mislabelled as speech and corrupting the MVDR covariance. Per-request override of the `OCTOVOX_CFAR_MASK` env default; **off = today's floor, byte-for-byte**. Proven on synthetic A/B ([`tools/cfar_eval.py`](tools/cfar_eval.py)), not yet on real-recording listening — hence experimental |

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
  ├── report.html               # standalone report — only when "Generate report" is on
  ├── visualization.png         # 4-panel figure embedded in the report (report only)
  └── …                         # extra instrument outputs only if the instrument is run
```

### Report

When the **Generate report** toggle is on (it is **off by default** so the
matplotlib render stays off the request hot path — set `report=true` on
`/api/clean`, or tick the box in the console), a clean run writes a
self-contained **`report.html`** (the **📄 Report** button opens it; `/api/clean`
returns its URL, or `null` when the report was skipped). It embeds
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
