# PORTING.md — Acceptance contract for the React rebuild of the New_OCTOVOX UI

This document is the **complete behavioral inventory** of the legacy UI. Every checked box
asserts that the React rebuild reproduces the cited behavior. Line citations refer to the
legacy sources as of this writing:

| Source | Path | Lines |
|---|---|---|
| index.html | `c:\Work\New_OCTOVOX\octovox_app\templates\index.html` | 411 |
| app.js | `c:\Work\New_OCTOVOX\octovox_app\static\app.js` | 2246 |
| shell.js | `c:\Work\New_OCTOVOX\octovox_app\static\shell.js` | 267 |
| ux.js | `c:\Work\New_OCTOVOX\octovox_app\static\ux.js` | 329 |
| errlog.js | `c:\Work\New_OCTOVOX\octovox_app\static\errlog.js` | 293 |

Conventions: "verbatim" means key names, payload field names, and numeric constants must be
byte-identical. Items marked **DECISION** require an explicit sign-off, not just code.

---

## 1. Capture

### 1.1 Tabs & mobile default

- [x] Three capture tabs (Record / Upload WAV / Sample) with active-class switching; panel id derived as `tab` + Capitalized(data-tab) — index.html:101-105, app.js:188-197
- [x] **Mobile sample-first default**: on `(max-width: 640px)` and when sessionStorage `octovox.tabChosen` is **unset**, auto-select the Sample tab; applied in `requestAnimationFrame` so layout/media-queries have settled — app.js:199-211
- [x] Any tab `pointerdown` writes sessionStorage `octovox.tabChosen = "1"` so the mobile override stops for the session — app.js:213-215
- [x] Programmatic tab selection helper (`selectCaptureTab`) used by shell/palette/onboarding — app.js:183-186

### 1.2 Record

- [x] Input device enumeration via GET `/api/devices`; failure paths render error `<option>` plus `#deviceWarn` with `.show` class — app.js:220-253
- [x] Devices sorted Polaris-like (≥8 ch) first; option text `OK/WARN #<idx> / <name> - <tag>`; first Polaris-compatible auto-selected — app.js:235-247
- [x] Device validation warning: selected device exposing `< 8` channels shows inline warning naming the channel count and the SB-POLARIS requirement; cleared otherwise — app.js:255-267 (REQUIRED_CH=8, REQUIRED_SR=48000 — app.js:9-10)
- [x] Rescan button re-runs device enumeration; device select `change` re-validates — app.js:270-271
- [x] Duration slider 2–30 s, default 6, live `<n> s` label — index.html:120-123, app.js:273-276
- [x] Filename text input, placeholder `rec_auto`; empty input falls back to `rec_<Date.now()>.wav` — index.html:124, app.js:340-341
- [x] **Preflight ("Test mics")**: POST `/api/preflight` `{device, channels:8, samplerate:48000}`; reveals `#levelsBlock`; busy label "Testing..." → restored to "Test mics (0.3 s)" — app.js:282-309. NOTE: initial HTML label is "Test mics" (index.html:134) but JS restores "Test mics (0.3 s)" — pick one in the port (DECISION, trivial).
- [x] **Preflight meter dB mapping**: per-channel bars map −60..0 dB → 0..100% height (min 2%), `silent` class when peak < −80 dB, `clip` class when peak > −1 dB; per-bar `ch <i>` label + `<p> dB` readout; warnings list rendered below — app.js:311-332
- [x] **Record flow**: POST `/api/record` `{device, channels, samplerate, seconds, filename}`; guard against re-entry via `state.recording` AND the Busy lock; button gets `.recording` class with a 1 Hz countdown `REC / <n>s remaining` — app.js:334-356
- [x] Recorded per-channel levels (`per_ch_peak_db`/`per_ch_rms_db` + warnings) rendered into the same preflight meter after recording — app.js:366-369
- [x] **Silent-recording guard**: if `peak_dbfs < -70` (default −120 when missing), refuse to analyse; multi-line diagnostic error toast naming the saved file and 4 likely causes (kit unpowered, wrong device, muted OS input level, OS mic privacy); still `refreshFiles()` so the saved file appears — app.js:370-383
- [x] Success toast includes peak dBFS and `gain_applied_db`; **Busy hand-off pattern**: release the record lock *before* `processFile(name)` so the clean re-acquires it; `finally` restores button only when not handed off — app.js:384-405. NOTE: button text resets to "Record & analyse" (app.js:391, 402) while initial HTML says "Record & clean" (index.html:135) — unify (DECISION, trivial).

### 1.3 Upload

- [x] Dropzone: click-anywhere (except buttons) opens file picker; separate "browse files" link; `fileInput.value=""` reset after handling so the same file can be re-picked — app.js:410-421
- [x] **Dropzone drag-state classes**: `dragenter`/`dragover` add `.drag`, `dragleave`/`drop` remove it; drop takes `dataTransfer.files[0]` — app.js:422-429
- [x] Non-`.wav` extension rejected client-side with an error toast naming the file — app.js:434-437
- [x] **500 MB client-side cap** (`file.size > 500*1024*1024`) with size-in-MB toast; server caps at 500 MB too — app.js:438-442
- [x] Upload acquires the Busy lock as `uploading <name>`; POST `/api/upload` multipart with optional `overwrite=1` field; treat HTTP 400 as a parseable JSON response (duplicate/spec-rejection), other non-OK as transport error — app.js:444-458
- [x] **Duplicate-handling 3-way modal** (`!j.ok && j.duplicate`): shows existing size (MB from `existing_size_kb`) and duration; buttons **Keep existing** (ghost/`cancel`) / **Replace** (danger) / **Save as `<suggested_name>`** (primary) — app.js:464-488
- [ ] **"Kept existing" navigation flow**: release Busy *before* `refreshFiles()` (awaited), navigate to Library, locate row by `data-name` (CSS-escaped), apply `flash-highlight` for 2400 ms, and toast a context-aware hint ("Click View..." if the row has `has-result`, else "Click Run...") — app.js:490-508
- [x] **Replace** re-uploads with `overwrite:1`; **Save-as** re-uploads a `new File([file], j.suggested_name)` — app.js:509-514
- [x] Spec-mismatch rejection path: `j.problems[]` rendered as a multi-line `- <problem>` error toast; otherwise generic upload failure toast — app.js:517-528
- [x] Success path: each `j.warnings[]` is its own warn toast; toast "Replaced ..." vs "Uploaded ..." via `j.replaced`; Busy hand-off to `processFile` (auto-run after upload) — app.js:530-541
- [x] Belt-and-suspenders `finally`: release the lock only if still held with `what` starting `"uploading"` — app.js:546-552
- [ ] `cssEscape` helper (CSS.escape with regex fallback) for filename attribute selectors — app.js:555-559

### 1.4 Sample

- [x] **Sample slider ranges**: Target SNR −5..+15 dB step 1, default +5, label rendered with explicit `+` for ≥0; Duration 3..12 s step 1, default 6 — index.html:158-167, app.js:563-569
- [x] Generate: POST `/api/sample` `{duration_s, snr_db}` (parseInt both); accepts `j.filename || j.name`; toast then Busy hand-off to `processFile` — app.js:571-599

---

## 2. Library

- [x] Refresh fetches `/api/list_input` and `/api/verdict` **in parallel** — app.js:755-759
- [x] **/api/verdict winner map**: build `wMap[stem] = recording` from `verdict.recordings[]`; this single map drives (a) winner pills, (b) row status accents, (c) the "Recently cleaned" sort, and (d) View-vs-Run row action logic — app.js:760-764
- [ ] AEC reference picker repopulated from the same file list on every refresh — app.js:765 (see §3.4)
- [x] Empty state: hide toolbar + show `#filesEmpty` when no files — app.js:774-781 (ux.js appends a "Generate a sample to try it" CTA — see §5.8)
- [x] Cached re-render: raw list + wMap stored on `state.filesAll`/`state.filesWMap`; sort/filter changes re-render with **no network round-trip** — app.js:749-753, 783-786
- [x] **Count badge**: `#filesCount` shows `N file(s)` or `X of N` when filtered — app.js:787-792. NOTE: the sidebar `#navLibraryCount` badge (index.html:33) is **never written by any JS — dormant**; either implement it for real or drop it (DECISION).
- [x] "No files match this filter." placeholder when the filter excludes everything — app.js:793-796
- [x] **Row rendering**: index number, WAV icon, name, winner pill, action buttons; status class on the row: `status-fresh` (no result), `status-gold` **only when `winner.winner === "Neural-MVDR-WPE"`**, else `status-analysed`; winner pill title `Bootstrap winner: <name> (<confidence>%)`; "not analysed" empty pill — app.js:798-822
- [x] Rows carry `data-name`, `data-idx`, `tabindex="-1"` (focusable for keyboard nav) — app.js:813
- [x] **'Open in Studio' vs 'Run' row action**: button label/title is `View`/`View results` when `wMap[stem]` exists, else `Run`/`Analyse`; click sets `state.selectedFile`, then `showResults(stem)` if results exist, else `processFile(fname)` with button showing `...` + `data-state="running"` while in flight — app.js:818, 829-843
- [x] **Rename flow (inline contenteditable)**: Edit button makes the name editable, focuses it, and pre-selects the basename **up to the last dot** (extension excluded); commit on blur or Enter, revert on Escape; no-op if unchanged/empty; POST `/api/rename` `{from, to}`; success toasts `Renamed to <j.new>` + refreshes; failure restores original text — app.js:845-885 (FileRow controlled input; api.renameFile fixed to send `{from, to}`)
- [x] **Delete flow**: confirm modal (ghost "Keep it" / danger "Delete") listing exactly what is removed; POST `/api/delete` `{filename}` — app.js:887-911
- [ ] Deleting the currently-open Studio file resets `state.currentStem/currentMetrics`, destroys both WaveSurfer instances, refreshes the Studio gate, and navigates Studio→Library if Studio is open — app.js:913-923
- [x] **Undo restore-token toast**: when `/api/delete` returns `restore_token`, show an action toast (`duration: 8000`, action label "Undo") that POSTs `/api/restore` `{token}`; restore success toasts `Restored <name>` + refreshes — app.js:927-934 and app.js:614-629
- [x] **Sort modes**: `newest` (mtime desc, default), `oldest`, `name` (localeCompare), `winrate` = **"Recently cleaned"** sorting by `wMap[stem].confidence` desc with −1 for unanalysed — app.js:944-965; dropdown options — index.html:184-189
- [x] Sort preference persisted to localStorage `octovox.fileSort` (read on init with `"newest"` fallback; written on change) — app.js:707-722
- [x] **Filter**: live, 80 ms debounce, case-insensitive substring on filename; filter text intentionally NOT persisted (always empty on fresh load) — app.js:710, 724-737, 946-948
- [x] **Filter clearing**: `X` button hidden when input empty, clears query + re-renders + refocuses input — app.js:730, 738-746; index.html:180
- [x] **Run all** (toolbar): refuses while busy/running; refreshes first; skips already-analysed files (wMap); toasts when nothing pending ("use Clear output first"); **drops target-speaker state up front** so batch results are order-independent; runs `processFile` sequentially with button text `Running i/n...` and per-file toasts; summary toast with ok/fail counts — app.js:975-1029
- [ ] **Clear output** (toolbar): guarded by busy checks; confirm modal (keeps inputs, removes all results, resets verdict); POST `/api/clear_output`; resets Studio state, destroys players, Studio→Library bounce, toasts `Cleared N result(s)` — app.js:1037-1088
- [x] `loadVerdict()` is a retired **no-op** kept for callers — app.js:1968-1973 — do NOT port a verdict UI; in React, simply drop the calls.

---

## 3. Studio controls

### 3.1 Presets

- [x] **PROD_PRESETS verbatim** — app.js:1308-1320. Record for payload parity:

  | preset | nr | beam | mask | residual | dereverb |
  |---|---|---|---|---|---|
  | `quality` | `dfn` | `auto` | `auto` | `0.6` | `none` |
  | `balanced` | `omlsa` | `auto` | `auto` | `0.55` | `none` |
  | `fast` | `fast` | `batch` | `coherent` | `0.45` | `none` |
  | `custom` | (leaves knobs untouched — no entry in the map) | | | | |

- [x] `applyProdPreset` sets only nr/beam/mask/dereverb/residual (guarded per-control); residual dispatches `input` so its live label updates; "custom" is a no-op — app.js:1322-1334
- [x] Touching any of **exactly these 8 knobs** flips the preset select to `custom`: prodNr, prodBeam, prodMask, prodDereverb, prodResidual, prodBlend, prodDfnCap, prodPauseFloor — app.js:1394-1406. NOTE: prodMovement/prodAgc/prodAec/checkboxes deliberately do NOT flip it — preserve or consciously change (DECISION).

### 3.2 Knobs & persistence

- [x] Full knob set + defaults as in markup: preset(quality), nr(dfn), beam(auto), movement(rtf), mask(auto), agc(rms), aec(partitioned), reference(None), dereverb(none), residual 0–1 step .05 default 0.6, checkboxes track✓ eq✓ report✗ — index.html:226-304
- [x] Advanced `<details>` group: blend 0–1 step .05 default 0.6, DFN cap 12–48 step 2 default 32 dB, pause floor −60..−12 step 2 default −40 dB, DOA readout✗, CFAR✗ (with the explanatory `title` texts, which ux.js promotes to styled tooltips) — index.html:306-322
- [x] Residual live label with verbal tag: `(off)` ≤0, `(gentle)` <0.45, `(natural)` <0.8, else `(aggressive)`, value `toFixed(2)` — app.js:1373-1382
- [x] Advanced live labels: blend `toFixed(2)`, DFN cap `<v> dB`, pause floor `-<|v|> dB` — app.js:1384-1392
- [x] **localStorage `octovox.studioSettings.v1`** — id-keyed object `{ controlId: value-or-checked }` over **PROD_PERSIST_IDS** = [prodPreset, prodNr, prodBeam, prodMovement, prodMask, prodAgc, prodAec, prodDereverb, prodResidual, prodBlend, prodDfnCap, prodPauseFloor, prodTrack, prodEq, prodDoaReadout, prodCfar] — app.js:1341-1346. **prodReference (file-specific) and prodReport (per-run intent) are intentionally excluded** — app.js:1337-1340, 1407-1409
- [x] Save on `change` of any persisted control (range inputs emit change on release, so no input-listener needed); restore on init fires bubbling `input` events so live labels sync — app.js:1348-1370, 1410-1417

### 3.3 getProdOpts serialization (POST body shape)

- [x] **getProdOpts() verbatim shape** — app.js:1465-1496. Always-present keys: `nr, beam, agc, aec, movement, mask, track, dereverb, residual (float), eq (bool), report (bool)`; `track` serializes checkbox→`"conditioned"|"audio"`. Conditional keys: `reference` only when picker non-empty; `mvdr_blend`, `dfn_atten_lim_db`, `pause_floor_db` (floats), `doa_readout`, `cfar` (bools) when controls exist; `target_az` (int) when aimed and `interferer_az` (int array) only when non-empty.
- [x] NOTE missing-element fallbacks differ from UI defaults (`nr:"fast"`, `agc:"perceptual"`, `movement:"srp"`, `mask:"snr"` — app.js:1467-1472). In React all controls always exist, so these fallbacks should be unreachable — but keep payload parity with controls *present* (the cutover diff in §7 catches this).

### 3.4 AEC reference picker

- [x] **AEC reference picker population**: filled from the input file list (reusing the already-fetched list when provided, else fetching `/api/list_input`); first option `None (AEC off)` value `""`; **preserves the current selection** if the file still exists; on fetch failure leaves existing options untouched; refreshed on init and every `refreshFiles()` — app.js:1444-1462, 765

### 3.5 Speaker targeting (chips + radar)

- [x] `azSep`: wrap-correct angular separation normalised to [0,360) then folded to [−180,180) — app.js:1096-1102
- [x] **Detect**: POST `/api/speakers` `{filename}`; stores `state.detectedSpeakers` + `state.speakersFile`; button shows `...` while busy; result toast `Found N talker direction(s)...` (ok) or "No distinct speaker directions found..." (warn); Detect uses `state.selectedFile || state.currentStem+".wav"` and warns when neither exists — app.js:1104-1129, 1421-1425
- [x] **Chips**: per-speaker button with rounded az (`+` sign for >0), strength bar (% width), title `Azimuth ±N deg / strength N% / activity N%`; active when `azSep(sp.az, targetAz) < 1.0`; click toggles select/clear; empty-state hint text — app.js:1131-1164
- [x] `selectSpeaker`: target = rounded az; **interferers = all detected azimuths ≥ 20° away**; toast announces extraction on next run — app.js:1166-1176
- [x] `setManualTarget` (radar click on empty space): normalises to [−180,180); interferers from detected list ≥20° away or `null` (pipeline auto-detects at run time); toast — app.js:1178-1188
- [x] Clear button: visible only when a target is set; clears target+interferers, toast "all voices" — app.js:1162-1163, 1190-1196, 1426-1427
- [x] **radarClickToAz with CSS-scale compensation**: maps client coords through `canvas.width/rect.width`; returns `null` within 8 px of centre (ambiguous); inverse mapping screen angle = (az − 90)° — app.js:1198-1209
- [x] **8° snap**: radar click selects a detected talker when `azSep < 8`, else manual aim — app.js:1428-1441
- [x] Target readout line: `all voices / Detect, or click the radar to aim` vs `target ±N deg [/ nulling ±N deg, ...]` with `armed` class — app.js:1211-1226
- [x] **Per-file speaker reset semantics**: `resetSpeakersForFile` clears target/interferers/list **only when the filename differs** from `state.speakersFile` (same file keeps the picker); called at the top of every run — app.js:1228-1237, 1508 (state/session.ts exact-parity early return)
- [x] **drawAzRadar**: 240×200 canvas (index.html:330); ring + 45° spokes + "F" front label at top + centre hub dot; blips at radius `R*(0.55 + 0.35*strength)` at screen angle (az−90)°; target blip 6 px with 9 px halo ring + accented spoke; **manual (non-detected) target drawn at 0.85·R with the same halo**; "click to aim" hint when nothing detected/aimed; all colors from theme tokens — app.js:1239-1302
- [x] Auto-detect after a clean (`maybeAutoDetect`): skipped during Run-all, when a target is set, or when this file's list already exists; fire-and-forget without the Busy lock — app.js:1677-1684

---

## 4. Studio run / results / A-B

### 4.1 Run + progress

- [x] `processFile(filename)` is an alias for `runProduction` — every caller (row Run, Run-all, post-upload/record/sample auto-run) goes through it — app.js:603-612 (hooks/useCleanStream.ts `useCleanRun` is the single entry point)
- [x] `runProduction`: Busy-acquire `cleaning <name>`, per-file speaker reset, `state.selectedFile`, progress titled `Cleaning voice (<nr>)...`; on success mark all stage pills done, hide progress, render, refresh files, **completion toast lists skipped stages** (`skipped: a, b` warn) or "all stages ran" (ok) with elapsed seconds; returns boolean for Run-all accounting — app.js:1498-1534
- [x] **NDJSON streaming reader with fallbacks**: POST `/api/clean_stream` `{filename, ...opts}`; (a) transport/network throw → sync fallback; (b) HTTP 404 or missing body → sync fallback; (c) other non-OK → error from JSON body when parseable; (d) line-buffered NDJSON parse tolerating partial chunks + blank lines + unparseable lines; `progress` events drive `updateProgress(msg, pct, stage)`; `error` event throws; `done` event resolved as the result; (e) **stream ends with zero events → sync fallback**; (f) stream ends with events but no done → hard error "clean stream ended without a result" — app.js:1536-1587 (lib/ndjson.ts; full fallback matrix unit-tested in ndjson.test.ts)
- [x] Sync fallback `cleanSynchronous`: POST `/api/clean` same body; throws `j.error` or HTTP status — app.js:1589-1598
- [x] `stripProdPrefix` removes leading `prod:` from progress lines — app.js:1600-1603
- [x] **STAGE_KEYWORDS** keyword→stage map verbatim (load/stft/mask/csm/bf/wpe/boot/render with their keyword arrays) — app.js:12-21. NOTE: these stage ids do **not** match the current HTML pill `data-stage` values (calibrate/highpass/vad/doa/beamform/nr/automix/output — index.html:81-90), so the keyword fallback effectively never lights a pill; the explicit `ev.stage` from the NDJSON stream is the working path. Port the explicit-stage path; carrying the dead keyword map is a DECISION (recommended: drop, documented here). **RESOLVED (Step 8): explicit-stage path only — the timeline is driven by the stream's `stage` ids; the keyword map stays in lib/constants.ts for the record but is not wired.**
- [x] Progress overlay: title/pct/fill/stage pills/log; stage pill state machine — pills before the active one get `done`, the active gets `active`, later ones cleared — app.js:653-683; log prepends timestamped lines, `fresh` class on newest, capped at 20 — app.js:684-692 (features/studio/PipelineTimeline.tsx — inline card per §7; same state machine, newest-first log capped at 20 with `fresh`)
- [x] **Sticky progress behavior**: mini-bar mirrors title/sub/pct/fill; appears with progress, hides with it; **clicking it smooth-scrolls to the full progress panel**; `aria-live="polite"` — app.js:631-651, 660-664, 694-698; index.html:378-383. (Superseded by the inline timeline in the rebuild — see §8; the *information* shown must survive.) (features/studio/StickyProgress.tsx: fixed pill shown when NOT on the running file's Studio; click navigates there — the inline timeline replaces the scroll target)

### 4.2 Results rendering

- [x] `renderProduction(j)`: sets `state.currentStem/currentClean`, refreshes the Studio gate, caption `<stem>.wav / <dur> s / <sr> kHz / <n> ch` (duration from `stages.mic_capsules.duration_s`) — app.js:1605-1613 (session.setResult + StudioView caption + ResultsHeader meta)
- [x] Headline stats: elapsed `Ns`, stages `ran/total`, **RTF = elapsed/duration** shown as `0.44x` — app.js:1615-1621 (ResultsHeader.tsx)
- [x] **Download** button navigates to `j.clean` (the clean WAV URL) — app.js:1623
- [x] **Report button gated on `j.report`**: enabled (opens in new tab, `noopener`) only when this run produced a report; otherwise `data-disabled` + warn toast "No report for this run." — no path guessing on fresh runs — app.js:1624-1627, 1692-1704
- [x] Re-run button re-invokes `runProduction(stem.wav)`; Playout button wired to `playToDevice(stem)` — app.js:1628-1631 (ResultsHeader Re-run → useCleanRun; PlayoutBar.tsx)
- [x] Output title: `Speaker @ ±N deg` when `stages.beamform.method === "extract_direction"` with a target az, else "Clean voice"; chain line from `buildChainText` — app.js:1633-1640
- [x] `buildChainText`: chain assembled **from stages that actually ran** — calibrate, HPF, VAD, DOA, `extract @±N deg` or `MVDR (<beam_mode>)`, dereverb, WPE, AEC, NR engine name, residual, automix, AGC/EQ, out — app.js:1654-1675 (lib/constants.ts, consumed by ResultsHeader)
- [x] A/B players loaded with `j.input` / `j.clean`; clean subtitle = `opthLabel(opts) / <elapsed>s` where opthLabel = `NR:<nr>[ / derev:<d>] / beam:<b>[ / EQ][ / target N deg]` — app.js:1642-1644, 1686-1690 (StudioView opthLabel, frozen per result)
- [x] Auto-navigate to Studio after render; then `maybeAutoDetect(stem)` — app.js:1646-1651 (useCleanRun)
- [x] **showResults re-view path** (View button, no re-run): loads `/output/<stem>/input_mono.wav` + `/output/<stem>/clean_prod.wav`, caption notes "re-run to refresh stage timings", wires Download/Re-run/Playout — app.js:1706-1719. **DECISION — 404-guess subtlety**: this path calls `setReportButton('/output/<stem>/report.html')` (app.js:1714) *without knowing whether a report exists*, so the Report button can 404 on re-view (fresh runs are correctly gated, app.js:1624-1627). The rebuild must either keep this conscious inconsistency or probe/ask the backend for report existence. **RESOLVED (Step 8 DECISION): probe.** Re-view issues a `HEAD /output/<stem>/report.html` and enables the Report button only when it answers OK (ResultsHeader.tsx); otherwise the button stays `data-disabled` with the legacy "No report for this run." warn toast. Fresh runs remain gated on `j.report` exactly as legacy — no path guessing anywhere.

### 4.3 Per-stage leaderboard / stage rack

- [x] **PROD_STAGE_LABELS verbatim**: 19 ordered stage keys (mic_capsules, mic_health, calibrate, highpass, noise_floor, dereverb_wpe, dereverb_spectral, vad, track_conditioning, doa, rtf_drift, beamform, aec, feedback_risk, noise_reduction, residual_suppress, automix, agc_eq_limiter, output) each with a friendly label and a **per-stage detail formatter** (e.g. calibrate → `gains a/b/... dB`, vad → `speech N%`, aec → `ERLE N dB / N taps`, agc_eq_limiter → AGC engine + target dBFS + limiter ceiling); skipped stages show `s.reason` — app.js:1884-1905 (lib/constants.ts, consumed by StageRack.tsx)
- [x] `renderProdStages`: timing-key remap `{dereverb_wpe, noise_reduction→nr, noise_floor, agc_eq_limiter}`; rows render OK/SKIP mark, label, formatter output (try/catch-guarded), `<ms> ms`; stages absent from the payload are omitted; trailing SUM row with `TOTAL/1000` s — app.js:1907-1932 (StageRack.tsx; + NEW proportional ms/max-ms timing bar per row; rendered for fresh results only — re-view shows the "re-run to refresh stage timings" hint instead, matching legacy data availability)

### 4.4 A/B compare & players

- [x] **WaveSurfer usage inventory** (see also §6 CDN item): two instances on containers `#waveInput` / `#waveWinner`; create-options: `waveColor`, `progressColor`, `height: 64`, `cursorColor`, `barWidth: 2`, `barGap: 1`, `barRadius: 1` — app.js:1730-1745; instances destroyed (try/catch) before every reload and on delete/clear-output — app.js:1723-1724, 916-918, 1075-1076; events used: `ready` (app.js:1822-1824), `finish` (app.js:1766-1773, 1858-1861); methods used: `load, destroy, playPause, isPlaying, pause, play, setVolume, setTime`/`seekTo` fallback, `getCurrentTime`, `getDecodedData`, `setOptions` (theme recolor, app.js:175-176) — (useWaveSurfer.ts: identical create-options; theme recolor implemented as destroy+recreate on mode change instead of `setOptions`; destruction happens on unmount/url change, so delete/clear-output tear down via the result clearing)
- [x] Per-track solo Play buttons: playing one pauses the other and resets its button; `Play`/`Pause` text + `playing` class; reset on `finish` — app.js:1748-1773 (NOTE: legacy left the un-selected side's volume at 0, so its solo button played silently; the port applies that track's level-matched gain when a solo starts — the next A/B action restores the mute state through the same `applyABVolumes` call legacy makes)
- [x] **Level-matched A/B**: single conceptual playhead; only the selected side audible (other muted to volume 0); `AB` state defaults to side `clean` — app.js:1778-1784, 1799-1802
- [x] RMS from decoded buffer, decimated to ≤ ~50k samples — app.js:1786-1797 (abEngine.ts `rmsOfBuffer`, unit-tested)
- [x] **Gain law verbatim: TARGET = 0.08 (~−22 dBFS); gain = clamp(TARGET/rms, 0.25, 4); rms ≤ 1e-5 → gain 1** — app.js:1804-1813 (abEngine.ts `computeABGains`, unit-tested incl. clamp boundaries + silence floor)
- [x] Gains recomputed on each player's `ready` — app.js:1820-1824 (plus an immediate recompute after recreate, since a theme/view flip rebuilds a player whose `ready` already fired)
- [x] RAW/CLEAN switch buttons set side + volumes + `active` class + `aria-selected` — app.js:1826-1832, 1864-1868
- [x] **A/B play button**: pausing pauses both; playing **starts BOTH from the active player's current time** (gapless mid-play flips), clears solo-button states first; `finish` resets — app.js:1834-1861
- [x] **`A` key flips RAW/CLEAN** only when both players exist, Studio is the current view, no modifiers, and not typing — app.js:1870-1881 (ABCompare keydown listener; mount-scoped to Studio, typing + open-modal suppressed)

### 4.5 Playout

- [x] **Output device picker**: GET `/api/devices_out`; `Default output` first option (value `""`); device options `Name (Nch)` with backend default pre-selected; all failure paths degrade to just "Default output" — app.js:1934-1949 (PlayoutBar.tsx)
- [x] **Playout**: POST `/api/playout` `{stem, device: <index|null>, name: "clean_prod.wav"}`; success toast includes target device + duration; failure toast — app.js:1951-1966 (PlayoutBar.tsx, legacy toast copy)

---

## 5. Shell

### 5.1 Router

- [ ] Hash routes `#/capture`, `#/library`, `#/studio` with `capture` fallback for anything else; `hashchange`-driven with a `_suppress` flag so programmatic navigation doesn't double-fire — shell.js:54-106
- [ ] Per-view title + subtitle in the workspace header (META map) — shell.js:56-60, 89-91
- [ ] Per-view header action buttons toggled by `data-view` attribute (Library: Run all/Clear output/Refresh; Studio: Re-run/Report/Download) — shell.js:92; index.html:60-69
- [ ] Navigating closes the mobile sidebar (`sidebar-open`) and scrolls workspace to top — shell.js:93-94
- [ ] **Studio gating**: nav item gets `nav-item-gated` class when `state.currentStem` is unset; Studio remains *reachable* and shows an empty state (no bounce) — shell.js:64-80, 86-88
- [x] Studio empty-state panel with CTAs: "Go to Library" → library; "Try a sample" → capture + sample tab + auto-click Generate — shell.js:247-255; index.html:203-212 (StudioView empty state; **DECISION (Step 9): the auto-clicked Generate is dropped** — the CTA opens the capture drawer on the Sample tab and the user confirms SNR/duration before generating; same change applies to the coachmark's "Try a sample")
- [ ] Sidebar hamburger toggles `sidebar-open` on `.shell` — shell.js:237-240
- [ ] External Acoustics nav item is a real navigation to `/acoustics` (not a route) — index.html:35; also a palette action — shell.js:132
- [ ] Boot order contract: app init wires everything, then calls `Shell.afterAppInit()` (Theme.init, Cmdk.init, wireSidebar, refreshGate, fromHash) — app.js:105-119, shell.js:258-266

### 5.2 Theme

- [ ] **Pre-paint script** (no flash): reads localStorage `octovox-theme` (default `system`), resolves `system` via `prefers-color-scheme`, sets `data-theme` on `<html>` before CSS loads; **`catch` fallback sets `data-theme="dark"`** — index.html:8-12
- [ ] Theme manager: pref values are `light`/`dark`/`system` (`system` is the *default* pref); **`toggle()` flips resolved light↔dark and writes the explicit value** (it is a 2-way toggle that abandons `system` — NOT a 3-way cycle; preserve or consciously upgrade, DECISION) — shell.js:25-43
- [ ] OS scheme changes re-apply when pref is `system` — shell.js:47-49
- [ ] **Cross-tab sync**: `storage` event on the theme key re-applies (newValue or `system`) — shell.js:50
- [ ] Toggle button icon/label sync (LIT/Light vs DRK/Dark) — shell.js:38-43
- [ ] **refreshThemedJsColors** called on every theme apply: re-reads CSS custom properties (`--wave-*`, `--radar-*`) via getComputedStyle and (a) `setOptions` recolors both WaveSurfer instances, (b) redraws the radar — app.js:156-179, shell.js:34
- [x] `T` key toggles theme (capture-phase, no modifiers, not typing) — shell.js:231-233 (App.tsx, bubble phase — see §5.6 note)

### 5.3 Command palette

- [x] Open via Ctrl/Cmd+K (capture-phase, preventDefault+stopPropagation), the sidebar `Ctrl K` pill, or the header "Commands" trigger; backdrop click closes; input focused ~20 ms after open with cleared query — shell.js:197-215, 221-223 (CommandPalette.tsx; **DECISION (Step 9): trigger placement** — the sidebar pill + header "Commands" button collapse into one app-bar `⌘K / Ctrl K` trigger, hidden < 820 px; the kbd-hint bar still advertises Ctrl K)
- [x] While open: Esc closes, ArrowUp/Down move selection (wrapping, scrollIntoView nearest), Enter runs — capture-phase so app.js shortcuts can't interfere — shell.js:224-230 (window CAPTURE-phase listener with preventDefault+stopPropagation, exactly like legacy; coordination with the Library's own capture-phase keys is state-based, not propagation-order-based: the panel keeps focus in the palette input — mousedown-prevented — so the Library handler bails on its typing-field guard, and App's bubble handler additionally checks `usePalette.open`)
- [x] **Subsequence fuzzy scorer verbatim**: subsequence match over lowercased label; score = `100 + bestRun*5 − firstIndex − (label.length − hits)*0.1`; no match → −1; empty query → 0 — shell.js:152-163 (fuzzyScore.ts, line-for-line port; hand-computed expectations unit-tested in fuzzyScore.test.ts)
- [x] Results sorted by score, **top 9**, first item pre-selected; mousemove selects, click runs; HTML-escaped labels; "No matching commands" empty row — shell.js:164-181 (React escapes text children by construction)
- [x] **Static actions list (all of them)** — shell.js:112-136:
  - Always: `New recording` (capture, record tab, focus record btn), `Upload a WAV` (capture, upload tab, open browse), `Generate sample` (capture, sample tab, focus), `Go to Library`, `Clean all files`, `Clear all output`, `Refresh file list`
  - Only when Studio-ready: `Go to Studio`, `Re-run clean`, `Download clean WAV`, `Open report`, `Play to device`, `Detect speakers`
  - Always (tail): `Open Acoustics` (location.href), `Toggle theme`, `View error log`, `Keyboard shortcuts`

  **DECISION (Step 9) — palette action wiring.** The legacy clickIf(buttonId) DOM wiring is
  replaced by a zustand command registry (commands.ts) plus direct store/api calls:
  - `Clean all files` / `Clear all output` / `Refresh file list` are registered by BatchBar and
    `Generate sample now` by SamplePanel — they are offered **only while their owning component
    is mounted** (Library with files / capture drawer open). Accepted IA deviation from the
    always-listed legacy actions; the static `Go to Library` / `Generate sample` actions remain
    the navigation path when the owners are unmounted.
  - `New recording` / `Upload a WAV` / `Generate sample` open the capture drawer on the right
    tab; the legacy extra button-focus and auto-opened browse dialog are dropped (no DOM ids).
  - Studio-ready actions: `Go to Studio` navigates; `Re-run clean` runs useCleanRun directly;
    `Download clean WAV` resolves the fresh result URL or `/output/<stem>/clean_prod.wav`;
    `Open report` gates on `j.report` for fresh runs and HEAD-probes on re-view (§4.2
    decision), opening the tab synchronously to stay popup-blocker-safe; `Detect speakers`
    runs the real detect flow (shared session store + /api/speakers, legacy toast copy);
    `Play to device` is **navigation-only** (goStudio) because the output-device choice is
    PlayoutBar-local state.
- [x] **Dynamic `Open <file>` actions** built from currently-rendered file rows: navigate to Library, then after 60 ms find the row by CSS-escaped `data-name`, `flash-highlight` 2 s, scroll to center, focus — shell.js:137-149 (built from the shared `['files']` query — not just rendered rows — and handed off via flashFile(); the flash store replaces the 60 ms timeout + CSS.escape lookup)

### 5.4 Toasts

- [ ] `toast(msg, type?, opts?)` with types `ok`(default)/`warn`/`error`; durations **error 7000 / warn 6000 / default 3000 ms**, overridable via `opts.duration`; `pre-wrap` text node; X dismiss button with slide-out animation; appended to `#toastWrap` (stacking) — app.js:1983-2042
- [ ] **Dedup window + action exemption**: identical message within **1.2 s** is dropped — **unless the toast carries an action** (so an Undo is never swallowed) — app.js:1992-1998
- [ ] **Action toasts**: `opts.action = {label, onClick}` renders an inline button; click runs the callback then dismisses (finally-guarded) — app.js:2019-2028

### 5.5 Modals

- [ ] `showModal({icon, iconType, title, body(HTML), buttons[{id,label,variant}]}) → Promise<string>` resolving the clicked button id, or `"cancel"` on backdrop click / Esc / replacement; **only one modal at a time** (opening a second force-cancels the first) — app.js:2045-2106
- [ ] Auto-focus the first `.primary`/`.danger` button (else first button) after ~30 ms — app.js:2099-2104
- [ ] Esc-close is implemented by the **global** keydown handler, not the modal itself — app.js:2174-2175

### 5.6 Keyboard shortcuts (full map: ?, /, R, A, D, arrows, Enter, Esc, T, E, Ctrl+K)

- [x] **Esc cascade order**: (1) close active modal → (2) dismiss **newest** toast (clicks last child's close button) → (3) clear focused file row (remove `file-row-focused` + blur); Esc works even while typing — app.js:2172-2188 (App.tsx bubble handler + LibraryView's capture handler for step 3; the error log slots in after the modal; a palette-open Esc never reaches the cascade — the palette stops it in the capture phase)
- [x] All other single-key shortcuts suppressed while typing in input/textarea/select/contenteditable, while a modal is open, or with Ctrl/Meta/Alt held — app.js:2122-2128, 2190-2195 (plus suppressed while the palette is open, matching shell.js:224-230's early return)
- [x] `?` (or Shift+/) → shortcuts help modal (content enumerated in §6 keyboard table) — app.js:2197-2201, 2149-2170 (ShortcutsHelp.tsx via the shared modal store)
- [x] `/` → focus + select the Library filter input — app.js:2203-2208 (Library's capture handler while mounted. **DECISION (Step 9) — global hoisting:** from the Studio, an App-level fallback navigates to the Library; pressing `/` again focuses the filter. Navigation-only was chosen over a one-shot focus signal as the simplest reliable option — no extra cross-feature store, no race with the Library mount/fetch.)
- [x] `R` → `refreshFiles()` + "Files refreshed" toast — app.js:2210-2215 (Library's capture handler while mounted; **App-level fallback (Step 9)** invalidates `['files']` + `['verdict']` with the same toast from anywhere else — handlers can't double-fire because the fallback only runs when the route view is not `library`)
- [x] **File row keyboard navigation**: ArrowDown/ArrowUp move focus across rows **with wrap-around** (down from none → first; up from none → last); focused row gets `file-row-focused` + real focus + smooth scrollIntoView nearest — app.js:2130-2147, 2217-2231
- [x] `Enter` on a focused row → clicks its analyse/View button; `D` → clicks its delete button (delete confirm modal) — app.js:2232-2245
- [x] `A` → flip A/B (Studio only — see §4.4) — app.js:1870-1881
- [x] `T` → theme toggle (shell, capture phase) — shell.js:231-233 (App.tsx bubble handler — capture phase is unnecessary now that nothing else claims T; the palette-open guard preserves the legacy "palette owns the keyboard" rule)
- [x] `E` → toggle error log (skipped while typing, with modifiers, or when the palette is open) — errlog.js:271-283
- [x] `Ctrl/Cmd+K` → palette toggle; palette-open keys (Esc/arrows/Enter) handled in capture phase — shell.js:221-230 (CommandPalette.tsx; works while typing, exactly like legacy)

### 5.7 Error log (errlog.js)

- [ ] **Capture surface**: `window 'error'` (message + stack or file:line:col) — errlog.js:80-84; `unhandledrejection` (reason message + stack) — errlog.js:85-89; **console.error/console.warn wrapped** (originals still fire; args stringified, `.message` preferred, objects JSON-safe; own `[errlog]` noise skipped; first arg with `.stack` becomes detail) — errlog.js:91-105; **failed-fetch tap**: fetch wrapped, non-OK responses on `/api/` URLs recorded as `HTTP <status> / <path>` with method+URL detail, network throws recorded then **re-thrown (never swallowed)** — errlog.js:114-130
- [ ] Deliberate non-capture: `toast()` is NOT intercepted (hoisted-function-call rationale documented) — errlog.js:107-111
- [ ] Entry shape: `{ts, type: error|warn, msg ≤600 chars, detail ≤2000 chars, where: current-route}` — errlog.js:62-74; explicit logging API `window.octovoxLogError` — errlog.js:76
- [ ] **Ring buffer of 50** mirrored to localStorage `octovox.errorlog.v1` (load on boot, save on change) — errlog.js:23-24, 35-52
- [ ] **Burst dedupe**: identical msg within **1.5 s** increments a `count` on the last entry (rendered as `xN`) instead of appending — errlog.js:42-52, 184
- [ ] **Unseen badge**: count of entries newer than `octovox.errorlog.seen.v1` timestamp shown as a dot on the Commands trigger (`9+` cap, tooltip); marking-seen on open — errlog.js:25, 55-59, 216-232
- [ ] Modal viewer (lazy-built): newest-first list, ERROR/WARN tags, time/date/where meta, `<pre>` detail, Copy (clipboard with execCommand fallback, confirmation toast) / Clear / Close (X focused on open), backdrop click closes, footer notes "Local only / last 50 events / E opens this" — errlog.js:136-258
- [ ] Public API `window.OctovoxErrors` {open, close, toggle, log, clear, count} (used by the palette) — errlog.js:260-268
- [ ] Separately, app.js has its own **global error trap**: uncaught error / unhandled rejection → error toast "UI reset", `Busy.release()`, `hideProgress()` — the UI can never stay locked after a crash — app.js:85-102

### 5.8 Onboarding & UX layer (ux.js)

- [x] **Tooltip system**: native `title` attributes lazily promoted to `data-ux-tip` (+`aria-label` fallback, native title removed); delegated mouseover/focusin so dynamic rows work; 320 ms hover delay (instant on focus or reduced-motion); positioned above with below-flip + viewport clamping (max-width 280); hidden on mouseout/focusout/scroll — ux.js:31-94 (Tip.tsx: TipLayer keeps the legacy delegated model — one fixed tooltip element + document-level listeners — so every `title=` in the React tree is promoted, same delays/placement/clamping; promotion checks the native title FIRST so a re-rendered element with a *changed* title is re-promoted; plus an explicit `<Tip text>` wrapper for new shell chrome)
- [ ] **Help popovers**: `?` buttons appended to the four control-group headings (Preset; Noise / Beam / Movement / Mask; AGC / AEC / Dereverb; Target speaker) keyed by heading text, with the HELP copy (title/body HTML/tip) — ux.js:100-163; popover placed right of anchor with left-flip + clamping; closes on outside click, Esc, scroll; toggle on re-click of same anchor — ux.js:139-179 — **DEFERRED (Step 9):** requires SettingsPanel/SpeakerCard composition changes, which were out of this step's file scope; the per-control `title` texts those headings group are already styled tooltips via TipLayer. Port the HELP copy as a `<HelpPop>` next to each `.ctl-group-head` in a follow-up.
- [x] **Onboarding coachmark** (first-run, localStorage `octovox.onboarded.v1`): only on the Capture view, 700 ms after boot, anchored under the Record button (flips above on overflow, arrow tracks anchor); body explains the 3 tabs; Dismiss and "Try a sample" (selects sample tab, focuses + pulses `ux-attention` on Generate for 2.4 s) actions; **navigating away marks-as-seen and removes it** — ux.js:182-246 (Coachmark.tsx, same storage key/timing/flip/arrow/leave semantics. **Adapted to the new IA:** capture is a drawer, not the landing view, so the coachmark anchors to the visible '+ New' button — app bar on desktop, bottom tab bar on mobile; "Try a sample" opens the drawer on the Sample tab without auto-clicking Generate, per the §5.1 decision, so the focus-pulse is dropped with it)
- [ ] Library empty-state enrichment: "Generate a sample to try it" primary CTA (navigate + select tab + click) — ux.js:248-261 — **DEFERRED (Step 9):** the React empty state already ships a "New capture" CTA (LibraryView, out of this step's file scope); making it sample-specific is a one-line follow-up (`openCapture(); selectCaptureTab('sample')`).
- [x] **Keyboard-hint bar** (first-run, localStorage `octovox.hint.kbd.v1`): `? shortcuts / Ctrl K commands / / search`, dismiss X, auto-dismiss after 12 s — ux.js:267-285 (KbdHint in Coachmark.tsx; raised above the bottom tab bar on mobile)
- [ ] Button ripple on `.btn-primary/.ab-play/.modal-btn.primary` pointerdown only (skipped under reduced-motion) — ux.js:286-306 — **DEFERRED (Step 9):** cosmetic; the flat-minimal button language already signals presses via the `:active` translate.
- [ ] MutationObserver on `.views` re-attaches help buttons + empty-state CTA after app re-renders — ux.js:309-320 (in React this becomes ordinary component composition — port the *behavior*, not the observer) — tooltip delegation needs no re-attachment by design; the two consumers it served (help popovers, empty-state CTA) are the deferred items above.

---

## 6. Cross-cutting

### 6.1 Busy lock

- [ ] **Single-operation lock**: `Busy.acquire(what)` refuses (returns false) with a warn toast naming the running operation; `release()` idempotent; `document.body` gets `octovox-busy` class while held — app.js:37-59, 73-82
- [ ] **5-minute watchdog**: auto-release with console.warn + warn toast ("UI unlocked. Check the server terminal...") and `hideProgress()` — app.js:60-69
- [ ] Hand-off convention: producers (record/upload/sample) release before awaiting `processFile`, which re-acquires — app.js:386-393, 538-541, 585-587
- [ ] Run-all/Clear-output check `Busy.isBusy()` + `state.runningAll` up front instead of acquiring — app.js:975-981, 1037-1045

### 6.2 Document / page chrome

- [ ] `meta color-scheme: dark light`; title "OCTOVOX - Voice Cleanup Console"; inline SVG data-URI favicon — index.html:6-7, 18
- [ ] **Fonts**: Google Fonts preconnect + Inter (400-800) and JetBrains Mono (400-700) — index.html:13-15 (the radar canvas hardcodes "JetBrains Mono, monospace" — app.js:1260, 1299)
- [x] **WaveSurfer CDN**: `https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.min.js` — **major-pinned v7, floating minor** — index.html:405. React port should pin an exact v7.x npm version (DECISION: record the chosen version here). **RESOLVED: pinned `wavesurfer.js@7.12.7` (exact, no caret) in package.json; spectrogram plugin imported from `wavesurfer.js/dist/plugins/spectrogram.esm.js` as a lazy chunk.**
- [ ] Script order contract shell.js → app.js → ux.js → errlog.js (after the OCTOVOX_ENV inline script) — index.html:398-409
- [x] Sidebar footer: engine chip `#chipDeps` ("engine") and `48 kHz / 8 ch` chip — index.html:39-42. **`#chipDeps` is never updated by any JS — dormant** (DECISION: wire to `/api/env` in the rebuild or drop). **RESOLVED (Step 9): wired.** EngineChip.tsx in the app bar renders `DFN3 · WPE · VAD` from GET `/api/env` with unavailable engines struck/dimmed; its click popover carries version / GPU / CPU cores and absorbs the static `48 kHz / 8 ch` chip as the "Format" row (from `fs_required`/`n_ch`). Hidden < 820 px.
- [ ] HERO TYPEWRITER — **INTENTIONAL DROP** (replaced by a static tagline in the rebuild). Legacy behavior for the record: types the first of 4 messages once at 26–46 ms/char, then swaps in the styled HTML and fades the cursor; reduced-motion renders instantly — app.js:122-153, index.html:99

### 6.3 localStorage / sessionStorage contract (must be preserved verbatim)

| Key | Store | Shape | Written by | Read by |
|---|---|---|---|---|
| `octovox-theme` | localStorage | `"light" \| "dark" \| "system"` (absent = system) | shell.js:36 (Theme.set) | index.html:9 (pre-paint), shell.js:27 (pref), shell.js:50 (cross-tab storage event) |
| `octovox.studioSettings.v1` | localStorage | JSON object keyed by control id over PROD_PERSIST_IDS (app.js:1341-1345); values: string for value-inputs, boolean for checkboxes; `prodReference`/`prodReport` never present | app.js:1348-1356 (saveProdSettings, on change) | app.js:1358-1370 (restoreProdSettings, on init) |
| `octovox.fileSort` | localStorage | `"newest" \| "oldest" \| "name" \| "winrate"` | app.js:719 | app.js:709 (fallback `"newest"`) |
| `octovox.errorlog.v1` | localStorage | JSON array (≤50) of `{ts, type, msg, detail, where, count?}` | errlog.js:40 (save) | errlog.js:38 (load) |
| `octovox.errorlog.seen.v1` | localStorage | stringified epoch-ms timestamp | errlog.js:59 (markSeen) | errlog.js:57 (unseenCount) |
| `octovox.onboarded.v1` | localStorage | `"1"` flag | ux.js:230 | ux.js:189, 199 |
| `octovox.hint.kbd.v1` | localStorage | `"1"` flag | ux.js:281 | ux.js:274 |
| `octovox.tabChosen` | **sessionStorage** | `"1"` flag (per-session) | app.js:214 | app.js:206 (mobile sample-first gate) |

- [x] All storage access is try/catch-wrapped (private-mode safe) — app.js:707-711, shell.js:27/36, ux.js:20-23, errlog.js:29-32 (verified Step 9 across useTheme/settings/errlog/LibraryView/CaptureDrawer/Coachmark — every localStorage/sessionStorage touch is wrapped)

### 6.4 Keyboard map (must all work in the rebuild)

| Key | Context | Action | Source |
|---|---|---|---|
| `Ctrl/Cmd+K` | global (capture phase) | toggle command palette | shell.js:223 |
| `Esc` | palette open | close palette | shell.js:225 |
| `↑` / `↓` / `Enter` | palette open | move selection (wrap) / run | shell.js:226-228 |
| `T` | global, not typing | toggle theme | shell.js:231-233 |
| `E` | global, not typing, palette closed | toggle error log | errlog.js:271-283 |
| `Esc` | global, works while typing | modal → newest toast → clear row focus (cascade) | app.js:2174-2188 |
| `?` (Shift+/) | not typing, no modal | shortcuts help modal | app.js:2197-2201 |
| `/` | not typing, no modal | focus + select Library filter | app.js:2203-2208 |
| `R` | not typing, no modal | refresh files + toast | app.js:2210-2215 |
| `↓` / `↑` | not typing, file rows exist | move row focus, wraps; from nothing: ↓→first, ↑→last | app.js:2222-2231 |
| `Enter` | focused file row | analyse / view the row | app.js:2234-2239 |
| `D` | focused file row | delete the row (confirm modal) | app.js:2240-2245 |
| `A` | Studio view, players loaded, not typing | flip RAW/CLEAN | app.js:1870-1881 |

- [x] Shortcuts help modal lists exactly: Up/Down, Enter, D, R, /, A, E, Esc, ? + "disabled while typing" note (`T` and `Ctrl K` are advertised elsewhere — keyboard-hint bar + sidebar pill; the rebuild should add T/Ctrl+K to the help modal, DECISION) — app.js:2149-2170. **RESOLVED (Step 9): added.** ShortcutsHelp.tsx keeps the legacy nine rows and inserts `T` and `Ctrl K` before Esc/?, with the same closing line about typing fields.

---

## 7. NOT ports — NEW features (do not block on legacy citations; design docs required)

- [x] **Capability gating via GET `/api/env`**: disable/annotate the DFN option (NR select), WPE option (dereverb select), and VAD-dependent UI from `{has_dfn, has_wpe, has_vad}` (endpoint exists: `octovox_app/routes/api.py:1178`). **Verified: the legacy template injects `window.OCTOVOX_ENV` (index.html:398-404) but NO script reads it — it is dead data today.** The React app should fetch `/api/env` instead of template injection.
- [x] Waveform / spectrogram toggle on both Studio tracks (new visualization mode; WaveSurfer v7 spectrogram plugin or equivalent). (ABCompare per-track toggle; plugin lazy-imported, registered at create time, torn down by WaveSurfer.destroy(); mel scale, theme-aware colormap — roseus on dark, igray on light; playback stops before a recreate so the lock-step pair never desyncs)
- [x] **Inline pipeline timeline** replacing the modal/overlay progress block + sticky mini-bar (index.html:74-93, 378-383); must still surface: title, %, per-stage state (pending/active/done), scrolling log tail (cap 20), and remain visible while scrolled (the sticky bar's job). (PipelineTimeline.tsx inline on the running file's Studio; StickyProgress.tsx pill everywhere else — mounted at the App shell)
- [ ] **Studio file rail / master-detail**: persistent file list alongside the Studio so switching files doesn't bounce through Library (today: `showResults`/`runProduction` + router navigate).
- [ ] (Optional, surfaced by this audit) Wire the dormant `#navLibraryCount` sidebar badge and `#chipDeps` engine chip to real data (`/api/list_input` count, `/api/env`). — chip half DONE in Step 9 (EngineChip.tsx, see §6.2); the Library count badge has no sidebar equivalent in the new IA (the in-view `N file(s)` counter covers it) and stays open.

---

## 8. Cutover gate

The rebuild may replace the legacy UI only when **all** of the following hold:

1. **Every checklist box above is checked**, with each DECISION item carrying a written
   resolution (keep / change + rationale) in this file's history.
2. **Payload parity diff**: with identical knob settings (each of the 3 presets + 1 custom
   configuration touching every advanced knob + 1 configuration with a radar-aimed target and
   detected interferers + 1 with an AEC reference), capture the POST `/api/clean_stream`
   request bodies from the old UI and the new UI and diff them. The diff must be **empty**
   (same keys, same types, same values — including the conditional-key omission rules of
   getProdOpts, app.js:1465-1496, and the preset values table in §3.1).
3. Storage-contract parity: a browser profile that used the legacy UI (theme set, studio
   settings saved, sort = winrate, error log populated, onboarding seen) opens the React UI
   with all of those honored, and vice versa.
4. Keyboard map verified end-to-end against the table in §6.4 (manual pass or e2e).
5. Streaming-degradation drill: with `/api/clean_stream` returning 404, and separately with
   the stream dying after zero events, a clean still completes via `/api/clean`
   (app.js:1536-1598 semantics).
6. Busy-lock drill: starting a second operation mid-clean is refused with the naming toast;
   a artificially-hung clean unlocks the UI at 5 minutes (app.js:45-82).
