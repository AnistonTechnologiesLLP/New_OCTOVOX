# Changelog

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
