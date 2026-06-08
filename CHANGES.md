# Changelog

## 2026-06-06 — Target-speaker selection ("whose voice?")

Multi-talker recordings now have a speaker picker. Click **⊕ Detect** in the
Console controls to scan the recording with SRP-PHAT and get a chip strip of
detected talker directions; click a chip to extract that voice in the next run.

- **`detect_talker_directions`** (new in `prod_pipeline.py`): speech-weighted
  SRP-PHAT azimuth spectrum → greedy peak-pick with `min_sep` angular gate and
  `min_activity` sidelobe rejection → `{speakers:[{az, strength, activity}],
  spectrum:{az, power}}`. Always returns the full schema (even on silence, the
  early-exit paths now include `n_speakers:0, speakers:[], spectrum:{}`).
- **`extract_direction`** (new in `prod_pipeline.py`): direction-masked RTF-MVDR
  steered at `target_az`. PHAT-whitened coherent power builds a competitive mask
  `share = align_tgt^sharp / (align_tgt^sharp + Σ align_interf^sharp)` — the
  competitive ratio vs. the other detected talkers is what isolates a flanked
  speaker the small array can't null spatially. A directional post-filter
  (`G = clip(share, floor, 1)`, smoothed in freq×time) adds the low-frequency
  rejection that the MVDR spatial null misses. **Measured end-to-end isolation
  (detected angles, not oracle): outer talkers +13…+15 dB; a talker flanked on
  both sides +2…+5 dB** — see the accuracy note below.
- **`/api/speakers`** (new endpoint, `api.py`): `POST {"filename": "…"}` → runs
  `detect_talker_directions`, returns speaker list + azimuth spectrum (elapsed
  ~0.5–1 s, no pipeline run needed).
- **`/api/clean`** gains two new body params: `target_az` (float, degrees) and
  `interferer_az` (list of floats). When `target_az` is set, `run_production`
  routes stage [6] through `extract_direction`. When `interferer_az` is also
  supplied (from a prior `/api/speakers` call), the pipeline skips its own
  re-detection. Ignored when `target_az` is null (default behaviour unchanged).
- **`run_production`** gains `target_az=None`, `interferer_az=None` params. When
  set, `beam`, `mask`, and `mvdr_blend` are bypassed — the downmix blend would
  re-introduce the other voices.
- **UI** (`index.html`, `app.js`, `style.css`): **Target speaker** control with
  ⊕ Detect button, speaker chips (direction + strength bar), a small top-down
  azimuth radar canvas (detected speakers shown as dots, active target in teal),
  and a × Clear toggle. `getProdOpts()` passes `target_az`/`interferer_az` when
  a chip is selected; `state.selectedFile` tracks the last touched file so Detect
  works before the first clean run.
- **Tests**: 5 new tests in `test_prod_ports.py` (schema/silence, single-source,
  two-source, mono-beam return, fallback-on-mono). Full suite: **47 passing**.

### 2026-06-08 — accuracy pass (user: "angles are off when listening")

A disjoint-window isolation harness (10·log10 of target-window / other-window
energy) pinned down what's real and what isn't:

- **Detection has a ~10° inward (toward-centre) bias** on the 40 mm UCA for
  multi-source clips (true `[-60,0,70]` → detected `[-50,-10,60]`). The raw 1°
  SRP-PHAT argmax is exact for a *single* source — the bias is the peak-picker on
  the smoothed spectrum, where neighbouring talkers inflate each peak's inner
  flank. Extraction tolerates this (±10° target-steer ≈ ±1–2 dB), so it costs a
  little, not a lot.
- **Two "fixes" were tried and rejected for regressing the realistic path**: a
  raw-power azimuth *refinement* (maximises total overlapping power → lands
  *between* close sources, `[-40,-5,35]`→`[-24,-10,14]`), and geometric
  *null-steering* (injecting interferer `d·dᴴ` into Φ_v). Null-steering is huge
  with oracle angles (+0.8→+4 dB middle, +2→+25 dB outer) but with the biased
  detector its mis-located nulls fold onto the target and **collapse the flanked
  talker to −8 dB** — so it's gone. The data-driven masked MVDR stays the engine
  because it learns the interferer subspace from data, not geometry.
- **Shipped**: `extract_direction` default `sharp` **2.0 → 3.0** (sharper
  directional contrast) — the one robust, no-regression win (+0.4…+1.0 dB on
  separated talkers; `sharp≥4` overshoots and tanks the middle talker).
- **Front/back wrap fix** in `app.js`: angular separation now normalises JS's
  signed modulo (`azSep`), so a ±180° boundary pair reads 5° not 355°.
- **Per-file selection**: the picked azimuth is tied to its file
  (`resetSpeakersForFile`); switching files or running "Clean all" drops it so one
  recording's angle can't bleed into another.

**Bottom line**: outer talkers isolate cleanly; the middle-of-three is the
angular-resolution floor of a 40 mm array, and the real levers are a larger array
or manual fine-azimuth entry — not more DSP on this geometry.

---

## 2026-06-06 — CPU efficiency pass: faster *and* better defaults

A runtime/quality pass on the production path. The headline: the live default
beamformer had drifted to `tracked`, which was a **triple loss** — the per-frame
tracked MVDR is slower than batch's single solve, it scores **−2.5 dB vs batch on
~15/21 of these clips** (the 500-trial bootstrap, see `batch_mvdr_beamform`), and
the spatial-coherence `mask` only applies to the *batch* beam, so the `mask=auto`
default was a silent no-op under `tracked`. All fixes keep the Quality output
intact (or better); a new Fast preset trades a little quality for ~25 % less
runtime. Full suite **42 passing**.

- **`beam` default `tracked` → `auto`** (`run_production`, `/api/clean`,
  `index.html`). With `movement=rtf` (default) `auto` runs the cheaper, higher-SNR
  **batch** RTF-MVDR on static clips and switches to tracked only on sustained
  RTF drift — and it re-activates `mask=auto`. Faster, better, no regression.
- **Skip wasted tracking.** `track_doa` (SRP-PHAT azimuth) is front/back ambiguous
  on this UCA so it never steers the beam — it is now an **opt-in diagnostic**
  (`doa_readout`, default off), running only when actually needed for the auto
  decision. `rtf_drift` and the tracking-path conditioner run only when they can
  change the beam (`beam=auto`); a **forced** beam skips all three.
- **Report opt-in.** New `report` flag — `run_production` defaults it on (library
  callers), but `/api/clean` defaults it **off** so the 200–700 ms matplotlib
  render is opt-in. New **Generate report** UI checkbox; `report` URL is `null`
  when skipped.
- **Vectorized** the per-channel `sosfiltfilt` loops (`highpass`,
  `condition_tracking_path` → one `axis=-1` call) and the per-frame RMS in
  `calibrate_channels` / `mic_health_report` (block reshape + `nanmean` over the
  active-percentile gate) — numerically identical, less Python overhead.
- **DFN warmup at startup.** `pipeline.warm_up_models()` now also pre-loads the
  production DFN model (`_get_dfn_model`) — DFN3 is the default NR, so the first
  `/api/clean` no longer pays the `init_df()` model-load mid-request.
- **Fast preset** (UI `prodPreset` dropdown: Quality / Fast / Custom; Quality
  defaults unchanged): `nr=fast`, `beam=batch` (skips the movement detectors),
  `mask=coherence`, `residual=0.45`, report off → **~2.66 s / 0.33× real-time**
  vs ~3.55 s / 0.44× for Quality on `180_straight.wav`. Touching any knob → Custom.

> **Next lever (noted, not yet done):** with DFN warm the dominant CPU cost is now
> the beamform stage (~1.4–1.9 s; `mask=auto` doubles it by building two beams) and
> `rtf_drift`'s separate 8-channel STFT. Caching the multichannel STFT is the next
> optimization if more speed is needed.

---

## 2026-06-05 (later) — Residual noise mop-up: kill the bed DFN3 leaves behind

Users reported a quiet steady hiss/hum remaining *after* DeepFilterNet3. That is
DFN's naturalness cap (24 dB) deliberately leaving a low stationary floor. Added a
"strong but natural" denoise stack, all defaulted on, all dial-able:

- **Residual suppressor** (new `residual_suppress`, stage [8c] in
  [`prod_pipeline.py`](octovox_app/services/prod_pipeline.py)): a gentle SECOND NR
  pass that runs *after* DFN3. It models the now-stationary residual bed from the
  quietest frames (mean per-bin noise PSD, like `dd_wiener`) and removes it with an
  over-subtraction Wiener gain, smoothed across frequency **and** time to avoid
  musical noise. One knob, `residual` ∈ [0,1] (default **0.6**): `alpha = 1+1.6·s`,
  floor `= −16−16·s` dB. Edge-spike-safe (`boundary='zeros'/True`) and clamped to
  the input envelope. **Measured: −9 dB of extra noise-bed reduction on a real
  conference clip (−13 dB on synthetic) with voice RMS unchanged (−0.1 dB)**; runs
  in ~160 ms. The stage reports `bed_change_db` (quiet-frame RMS), not global RMS,
  so the effect is visible (global RMS is speech-dominated and barely moves).
- **DFN3 cap raised 24 → 32 dB** (`dfn_atten_lim_db` default): DFN now suppresses
  the bed harder while staying natural. `None` uncaps it; lower keeps a quieter 2nd
  speaker.
- **Automix pause floor deepened −24 → −40 dB** (`pause_floor_db`): speech *gaps*
  go near-silent so noise only sits under speech, where the beam + NR handle it.
- **UI**: a **Denoise strength** slider (`prodResidual`) in the console controls
  with a live gentle/natural/aggressive readout; new ⑧ Residual stage in the timing
  table. **API**: `/api/clean` accepts `residual` and `pause_floor_db`.
- **Tests**: `tests/test_prod_ports.py` +3 (bed-cut-but-keep-voice, strength
  monotonicity, off/bounded edge-safety). Full suite **42 passing**.

---

## 2026-06-05 — Production pipeline: ported DSP stages, RTF movement, noise-robust tracking

New capabilities, all in the production clean-voice path
([`prod_pipeline.py`](octovox_app/services/prod_pipeline.py)) with matching
`/api/clean` params, UI controls, and tests
([`tests/test_prod_ports.py`](tests/test_prod_ports.py)). Nothing was removed;
every upgrade is the new default with the prior behaviour one keyword/toggle away.
Five pieces were ported and recalibrated from a sibling research repo; two
(RTF-drift movement, tracking-path split) are new.

| Stage | Function | What it adds | Toggle (default) |
|-------|----------|--------------|------------------|
| 1b · Mic health | `mic_health_report` | per-capsule OK/WARN/FAULT/DEAD/CLIP diagnostic on the raw input | always on (read-only) |
| 5·track · Tracking path | `condition_tracking_path` | noise-robust, phase-preserving speech-band copy of the array for the trackers, so HVAC/projector noise can't steer the beam (~3× lower DOA error under directional rumble). Audio path untouched. | `track` (`conditioned`) |
| 5b · Movement | `rtf_drift` | ambiguity-free RTF-drift talker-movement detector; in `beam=auto` it **acts on** the signal (switch to tracked) where SRP-PHAT couldn't (front/back ambiguity) | `movement` (`srp`) |
| 7 · AEC | `aec_partitioned` | multi-tap partitioned STFT AEC for long echo tails (vs one-tap NLMS) | `aec` (`partitioned`) |
| 7b · Feedback risk | `feedback_risk` | sustained-tone (PA howl) diagnostic, calibrated to read `low` on clean speech | always on (read-only) |
| 10 · AGC | `perceptual_agc` | K-weighted attack/release loudness riding (vs instantaneous RMS), **with a fix for the startup gain blast** (seeds at steady-state active level — no over-loud first word) | `agc` (`perceptual`) |

- **Spatial-coherence (ASA) mask for RTF-MVDR** (`spatial_coherence`,
  `beamform_masked`): the energy soft-mask collapsed the 8 mics to mono before
  masking, so it was blind to direction. Added the ASA "common spatial location"
  cue (inter-mic magnitude-squared coherence) fused into the MVDR mask, so
  diffuse reverb/noise is pushed into the noise covariance. Measured with the
  500-trial bootstrap across all 21 recordings (seed-stable): **+4 to +12 dB on
  multi-talker / moving / reverberant clips**, mild −1 to −3 dB on already-clean
  single-talker ones. New `mask="snr"|"coherent"|"auto"` selector; **`auto`
  builds both beams and keeps the one an independent (mask-defined) proxy
  prefers** — "never worse than baseline" (full +1.8 dB mean gain kept, worst
  case −2.8 → −0.5 dB). Default `snr` (off). UI: **Mask** dropdown. See
  RTF_MVDR_TRACKED.md §12. Cost: `auto` runs the beamformer twice (opt-in).
- **Fast dereverb + edge-spike fix** (`dereverb_spectral`): the old WPE dereverb
  ran ~3× real-time, overshot peak (0.87→1.82), and only cut ~13% of the reverb
  tail. Added a fast single-channel late-reverb suppressor (Lebart/Habets
  statistical model) that runs on the mono beam in **~180 ms (~0.02× RT)** and
  cuts **33–57%** of the tail with the peak bounded to the input envelope. New
  `dereverb="none"|"spectral"|"wpe"` selector (`wpe=True` still maps to `"wpe"`;
  WPE's overshoot is now clamped). **Also fixed a latent ISTFT edge bug**: scipy
  `istft(boundary=None)` detonated the first frame of `dd_wiener` into a ~300×
  spike — switched to `boundary='zeros'` + envelope guard. UI: **Dereverb**
  dropdown replaces the WPE checkbox. Default stays off (no change to current
  output). Stage renders as ⑧ Dereverb in the table and report.
- **Standalone report** (new `prod_report.py`): every clean run now writes a
  self-contained `report.html` + `visualization.png` to `data/output/<stem>/`,
  the way the old instrument did but adapted to the single-output production path
  — raw-vs-clean A/B players, KPI strip (levels, noise-floor before→after,
  engines), a 4-panel figure (waveforms, raw & clean spectrograms, mic-health
  bars), diagnostics, and the per-stage timing table, all embedded inline.
  Surfaced via a **📄 Report** button and the `report` URL in the `/api/clean`
  response. Generation is wrapped so a report failure never fails the clean.
- **UI** ([index.html](octovox_app/templates/index.html), [app.js](octovox_app/static/app.js)):
  added **Movement**, **AGC**, **AEC** dropdowns, a **Noise-robust tracking**
  checkbox, and the **📄 Report** button; new diagnostic stages render in the
  per-stage table.
- **API** ([api.py](octovox_app/routes/api.py)): `/api/clean` now accepts
  `agc`, `aec`, `movement`, `track` (all validated, back-compatible defaults).
- **Tests**: `tests/test_prod_ports.py` (19 cases) covers each new function —
  mic-fault detection, AGC no-startup-blast, feedback static-vs-howl separation,
  partitioned-AEC echo reduction, RTF static-vs-moving margin, and tracking-path
  phase-preservation + directional-rumble rejection. Full suite: **30 passing**.
- **Honest scope notes** (kept out on purpose): no "half latency" claim (parallel
  paths don't halve latency; this pipeline is offline batch), and no multi-beam
  beam-weighting (OCTOVOX forms a single MVDR beam — nothing to deconflict).

---

## 2026-06-02 → 06-03 — Initial scaffold + Sprint B (GPU, tracked RTF)

_Window: 2026-06-02 ~11:00 → 2026-06-03 ~11:00. The repository has no git commits yet
(everything is staged in the initial working tree), so this log is reconstructed from
filesystem modification times and `git diff` (working tree vs. staged index)._

## Summary

| Area | File | Change | Size |
|------|------|--------|------|
| DSP pipeline | `octovox_app/services/pipeline.py` | GPU (CuPy) backend + time‑varying RTF/MVDR ("Sprint B") | +308 / −9 |
| Frontend JS | `octovox_app/static/app.js` | "Run all" + "Clear output" batch actions | +115 |
| API | `octovox_app/routes/api.py` | `/api/clear_output` endpoint | +20 |
| Template | `octovox_app/templates/index.html` | Two new toolbar buttons | +2 |
| Deps/docs | `requirements.txt` | GPU / CuPy install instructions | +35 |
| Tests | `tests/test_sprint_b.py` | New test for Sprint B work | new file |
| Data | `data/input/*.wav` | 4 sample recordings removed | 4 deleted |

---

## Timeline

### 2026-06-02 16:08 — Initial project scaffold
The full OCTOVOX Flask application was created: `octovox_app/` package (config, routes,
services, utils, static, templates), `run.py`, `PLAN.md`, `README.md`, `.gitignore`, the
`data/input` sample recordings, and the baseline `requirements.txt`. This is the baseline
that the changes below build on.

### 2026-06-02 18:08 — Sprint B test
- Added `tests/test_sprint_b.py` covering the new tracking pipeline work.

### 2026-06-03 10:25 — Pipeline: GPU acceleration + speaker tracking ("Sprint B")
[octovox_app/services/pipeline.py](octovox_app/services/pipeline.py) — +308 / −9.

- **Optional GPU DSP backend (CuPy).** Added a backend-agnostic path that moves the
  heaviest per-bin / per-frame linear algebra to the GPU via CuPy and returns plain
  NumPy, leaving the rest of the pipeline untouched. NumPy is a transparent fallback;
  set `OCTOVOX_GPU=0` to force the CPU path. CuPy is imported and warmed up (a tiny
  cuBLAS/cuSOLVER solve) **before** torch, to avoid the Windows "DLL load failed …
  cublas" issue.
- **Vectorized masked covariance build.** `compute_csm_masked` replaced the per-frequency
  Python loop (and its `(F,T,C,C)` intermediate) with a single batched matmul per class
  — far faster on both CPU and GPU.
- **Time-varying RTF tracking.** New `estimate_rtf_tracked` / `_estimate_rtf_tracked_impl`
  — a PAST subspace tracker (Yang 1995) combined with covariance-whitening, producing one
  RTF per STFT frame instead of a single static RTF. This follows a speaker who moves
  mid-recording, where the static RTF would lock onto stale geometry.
- **Time-varying MVDR.** New `bf_mvdr_tracked` / `_bf_mvdr_tracked_spectrum` — MVDR whose
  weights update every frame from the tracked RTF.
- **New algorithm in the lineup:** `"RTF-MVDR (tracked)"` added as a competing beamformer
  (progress stage ⑥), with graceful fallback if it fails.
- Added `cholesky_whiten_prep` helper (robust per-bin whitener with diagonal-loading and
  identity fallbacks).

### 2026-06-03 10:30 — Dependencies: GPU install guidance
[requirements.txt](requirements.txt) — +35.

- Documented CUDA-build torch install matched to Python version (verified on Python 3.14 +
  RTX 3050, CUDA 13.x), and older Python 3.10/3.11 + CUDA 12.1 instructions.
- Added CuPy install notes (`cupy-cuda13x[ctk]` / `cupy-cuda12x[ctk]`) for GPU DSP, the
  Windows import-order caveat, and which stages remain CPU-only (STFT, classical
  beamformers, bootstrap, WPE).

### 2026-06-03 10:47–10:48 — Frontend: batch "Run all" + "Clear output"
[octovox_app/routes/api.py](octovox_app/routes/api.py) (+20),
[octovox_app/templates/index.html](octovox_app/templates/index.html) (+2),
[octovox_app/static/app.js](octovox_app/static/app.js) (+115).

- **"Run all" button** — analyses every input recording in one click. Drives `processFile()`
  sequentially (the pipeline is single-threaded; `Busy` enforces one op at a time),
  skips files already analysed, shows live `Running i/n…` progress, and reports a summary.
- **"Clear output" button** — removes all previous analysis results after a confirmation
  modal; input `.wav` files are kept. Resets the open results view and the verdict.
- **`POST /api/clear_output`** — deletes every `/output/<stem>` directory; preserves
  `.gitkeep` and input files.
- `processFile()` now returns a success boolean so the batch runner can count
  successes vs. failures (backward-compatible — existing callers ignore the return).

### Working-tree data changes
- Removed 4 sample recordings from `data/input/`: `Side_90_downward.wav`,
  `Stand_position_new_upward_side.wav`, `Stand_position_upward_side.wav`,
  `sitting_position.wav`.
