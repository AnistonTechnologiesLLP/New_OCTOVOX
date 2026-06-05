# RTF-MVDR in OCTOVOX — Batch vs. Tracked (Backend Reference)

> **Purpose of this file.** A self-contained handoff doc (shareable to another
> Claude session) describing how the two RTF-MVDR beamformers work in the
> backend, the equations behind them, the change that made the *tracked* variant
> actually useful, and a measured comparison. All code lives in
> [`octovox_app/services/pipeline.py`](octovox_app/services/pipeline.py).

---

## 0. TL;DR

- There are **two** RTF-MVDR beamformers in the lineup:
  - **② `RTF-MVDR`** — *batch / static*: one steering vector estimated over the
    whole recording. CPU only.
  - **⑤ `RTF-MVDR (tracked)`** — *time-varying*: steering vector changes over
    time so it can follow a moving / multi-talker scene.
- The tracked variant **used to** use a per-frame **PAST subspace tracker**
  (Yang 1995). It was measured to be **consistently worse than its own static
  batch baseline on every test clip** — the per-frame estimate was too noisy.
- **The change (2026-06-03):** replace PAST with a **sliding-window
  covariance-whitening RTF** — re-solve the *same* batch RTF estimator on short
  overlapping windows (~0.25 s) and assign each STFT frame the RTF of its
  nearest window. Only the *steering estimator* changed; the MVDR apply and the
  noise model are untouched.
- **Result:** across 7 real/synthetic clips the tracked slot went from a strict
  loser to **net-tied with batch (mean ≈ 0.00 dB)** and now **wins on 4/7
  clips** — notably multi-talker / mixed-posture conference recordings
  (+1 to +3 dB bootstrap-median SNR).

---

## 1. Signal model & STFT front-end

8-microphone uniform circular array (sensiBel Polaris UCA, radius 40 mm, all
mics in the **z = 0 plane** → planar array). Constants in `pipeline.py`:

```
FS_REQUIRED = 48000 Hz      NFFT = 1024      HOP = NFFT//4 = 256
N_CH = 8                    F  = NFFT//2 + 1 = 513 freq bins
frames/sec = FS/HOP = 187.5
```

Multichannel STFT `stft_multich(x)` → `X` of shape **(F, L, C)** = (513, #frames, 8),
where `C = M = 8` mics.

Per (frequency `f`, frame `l`) we have an 8-vector **y(f,l) ∈ ℂ⁸**. The physical
model for a single target with additive noise:

```
y(f,l) = a(f)·s(f,l) + n(f,l)
```

- `s(f,l)` — target source STFT (scalar)
- `a(f) ∈ ℂ⁸` — **acoustic transfer function** of the target to the 8 mics
- **RTF (Relative Transfer Function)** `h(f) = a(f) / a_ref(f)` — the ATF
  normalized to a reference mic, so `h[ref] = 1`. This is what both algorithms
  estimate. It encodes the target's direction/geometry relative to the array.

---

## 2. Shared building blocks

Both algorithms are built from the same three primitives.

### 2.1 Soft speech mask — `estimate_softmask(X)`
Per-bin sigmoid on posterior SNR vs. a noise floor → `mask ∈ [0,1]` of shape
(F, L). `mask≈1` on target-dominant (f,l), `≈0` on noise-only.

### 2.2 Masked spatial covariance matrices — `compute_csm_masked(X, mask)`
Mask-weighted Gram matrices, vectorized over all bins:

```
Φ_x(f) = ( Σ_l  mask(f,l) · y(f,l) y(f,l)ᴴ ) / Σ_l mask(f,l)      # speech-dominant SCM
Φ_v(f) = ( Σ_l (1-mask(f,l)) · y(f,l) y(f,l)ᴴ ) / Σ_l (1-mask(f,l))  # noise SCM
```

Each is (F, C, C) = (513, 8, 8). `regularise()` adds diagonal loading so they
stay invertible / positive-definite.

### 2.3 Covariance-whitening RTF — `estimate_rtf(phi_x, phi_v, ref)`
The **Markovich-Golan & Gannot (2009)** estimator. Per bin, solve the
**generalized eigenproblem**

```
Φ_x(f) v = λ Φ_v(f) v
```

take the eigenvector `v_max` of the **largest** eigenvalue (the target subspace
after whitening by the noise), de-whiten, and normalize to the reference mic:

```
h(f) = Φ_v(f) · v_max(f)
h(f) = h(f) / h(f)[ref]          # so h[ref] = 1
```

Returns the **static RTF** `rtf` of shape **(F, C)**. Robust two-tier fallback:
plain `scipy.linalg.eigh` → diagonal-loaded retry → identity (`e_ref`) if both
fail. **CPU-only on purpose** (SciPy *generalized* `eigh`; CuPy has no
equivalent, and it's already sub-second).

---

## 3. Algorithm ② — Batch RTF-MVDR (`bf_mvdr`)

**One** steering vector for the whole recording.

```python
rtf      = estimate_rtf(phi_x, phi_v, ref=ref_ch)   # (F, C), static
w        = bf_mvdr(rtf, phi_v)                       # (F, C) weights, static
Y(f,l)   = wᴴ(f) · y(f,l)                            # apply_beamformer
audio    = istft_single(Y)
```

### MVDR weights
The minimum-variance distortionless-response solution: minimize output noise
power subject to unit gain on the target steering `h`.

```
        Φ_v⁻¹ h
w  =  ─────────────          (per frequency bin f)
       hᴴ Φ_v⁻¹ h
```

Code ([`bf_mvdr`](octovox_app/services/pipeline.py)):
```python
v     = solve(Φ_v, h)        # Φ_v⁻¹ h     (robust loaded solve)
denom = hᴴ v                 # hᴴ Φ_v⁻¹ h
w     = v / denom
```

**Distortionless guarantee:** `wᴴ h = 1` exactly → the target passes with unit
gain and zero distortion, *provided `h` is correct*.

**Strengths:** `h` is averaged over the entire recording → **very low variance,
well-conditioned**. Optimal when the source geometry is **fixed**.
**Weakness:** if the talker moves mid-recording, the single `h` is a stale,
direction-smeared average.

---

## 4. Algorithm ⑤ — Tracked RTF-MVDR

Goal: let the steering vector **change over time** so it can follow a moving
talker or a shifting multi-talker scene, where a single static `h` is a poor
fit.

```python
rtf_track = estimate_rtf_tracked(X, phi_v, mask, ref=ref_ch)   # (L, F, C) !
audio     = bf_mvdr_tracked(rtf_track, phi_v, X, n_out=...)     # returns AUDIO
```

Note the shape: the tracked RTF is **(L, F, C)** — one RTF *per frame* — vs. the
batch **(F, C)**. Because the weights change every frame they can't be stored as
one matrix, so `bf_mvdr_tracked` applies them internally and returns audio
directly (same pattern as the Neural-MVDR-WPE slot).

### 4.1 Time-varying MVDR apply — `bf_mvdr_tracked` / `_bf_mvdr_tracked_spectrum`
The **noise covariance stays global/batch** (`Φ_v` is stationary and far better
conditioned over the whole record than over a 0.25 s window). Only the steering
`h(l,f)` is time-varying:

```
            Φ_v⁻¹ h(l,f)
w(l,f) = ─────────────────────
          h(l,f)ᴴ Φ_v⁻¹ h(l,f)

Y_out(f,l) = w(l,f)ᴴ · y(f,l)
```

`Φ_v⁻¹` is computed **once** per bin (batched `_batched_inv_loaded`) and reused
for every frame; the per-frame weights/outputs are pure einsums. Runs on
GPU (CuPy) when available, else NumPy — **mathematically identical** either way.

---

## 5. THE CHANGE — what made tracked better

### 5.1 Old estimator (REMOVED): per-frame PAST subspace tracker
`estimate_rtf_tracked` previously ran a rank-1 **Projection Approximation
Subspace Tracking** recursion (Yang 1995): whiten each frame by the batch noise
Cholesky factor, do a mask-gated rank-1 update of the principal subspace `ψ`,
de-whiten, normalize. One RTF per frame, sequentially.

**Why it underperformed:** the per-frame rank-1 estimate is **noisy**. A wrong
`h(l,f)` still satisfies `w(l,f)ᴴ h(l,f) = 1` — i.e. MVDR is "distortionless"
with respect to the *wrong* direction — so the actual target gain **fluctuates
frame-to-frame**, lowering coherent speech energy and leaking noise. That
~2–3 dB penalty exceeded any benefit from tracking. The old
`_estimate_rtf_tracked_impl` was deleted.

### 5.2 New estimator (SHIPPED): sliding-window covariance whitening
`estimate_rtf_tracked(X, phi_v, mask, ref=0, win_s=0.25, step_s=None)`:

Re-solve the **same low-variance batch `estimate_rtf`** on short overlapping
windows of speech-masked frames, then assign each frame the RTF of its nearest
window.

**Parameters** (defaults are the tuned optimum):
```
win_s  = 0.25 s   → W = round(0.25 · 187.5) = 47 frames per window
step_s = win_s/4  → S = round(0.0625 · 187.5) = 12 frames between windows  (75% overlap)
```

**Per window [a, b):** windowed speech SCM (the windowed counterpart of
`compute_csm_masked`, helper `_windowed_speech_csm`):
```
Φ_x^(w)(f) = ( Σ_{l=a}^{b}  mask(f,l) · y(f,l) y(f,l)ᴴ ) / Σ_{l=a}^{b} mask(f,l)
h_w(f)     = estimate_rtf(  regularise(Φ_x^(w)) ,  Φ_v_global ,  ref )   # (F, C)
```
Note `Φ_v` is the **global** noise SCM, *not* windowed — only the target
steering is time-varying.

**Per-frame assignment** (piecewise-constant, nearest window center):
```
rtf_track[l] = h_{ k* }      where  k* = argmin_k | center_k − l |
```

**Why it works:** every window is itself a **batch** estimate → low variance,
well-conditioned — but short enough to follow azimuth motion / scene changes.
It keeps the batch estimator's robustness while regaining adaptivity. It also
degrades gracefully: tiny input → falls back to a single static RTF broadcast
over all frames.

### 5.3 Backend / device note
Both RTF-MVDR variants estimate the RTF on **CPU** (SciPy generalized `eigh`).
Only the *time-varying MVDR apply* (`_bf_mvdr_tracked_spectrum`) and the masked
covariance build optionally use the **CuPy GPU backend** (`GPU_DSP`), with NumPy
as a transparent, identical-math fallback. **GPU vs CPU does not change quality
— it never explained the gap.** (On the dev machine `GPU_DSP=False`,
`HAS_CUDA=False` → everything is CPU.)

---

## 6. Comparison

### 6.1 Conceptual

| | **② Batch RTF-MVDR** | **⑤ Tracked RTF-MVDR (sliding-window)** |
|---|---|---|
| RTF estimate | one, whole recording — `(F,C)` | per-frame from ~0.25 s windows — `(L,F,C)` |
| Noise cov `Φ_v` | global | global (same) |
| Variance of `h` | very low | low (each window is a batch solve) |
| Adaptivity | none | follows azimuth motion / scene changes |
| Output | weights applied once | weights vary per frame; returns audio |
| Device | CPU | RTF on CPU; MVDR apply CPU/GPU |
| Best when | fixed single talker | moving / multi-talker / mixed-posture |

### 6.2 Measured (pipeline's authoritative metric)

**Metric:** bootstrap **median** SNR (loud-vs-quiet RMS gap, `bootstrap_compare`),
loud/quiet windows labeled against the **8-channel mean** `x.mean(axis=1)` —
exactly what `process_file` ranks on.

**Sliding-window vs. the old PAST tracker** (tracked-slot median / win-rate):

| Clip | PAST (median / win%) | **Sliding-window (median / win%)** | Batch (median) |
|---|---|---|---|
| Azimuth-sweep (synth) | 28.3 / 9% | **29.4 / 20%** | 30.8 |
| Sitting (static) | 29.2 / 9.5% | **31.6 / 27%** | 31.1 |
| Elevation-moving | 27.5 / 1.5% | **33.7 / 11%** | 37.0 |

→ Sliding-window improved the tracked slot's median by **+1 to +6 dB** and
2–3× the win-rate on every clip.

**Sliding-window tracked − batch, across 7 clips** (bootstrap median, W=0.25):

| Clip | tracked − batch |
|---|---|
| Conference_room_90_degree_2_person | **+3.10 dB** ✅ |
| Conference_room_two_person_talk | **+1.28 dB** ✅ |
| Conference_room_sitting | **+1.21 dB** ✅ |
| Conference_room_one_sitting_one_stand | **+1.07 dB** ✅ |
| synth_azimuth_sweep | −1.33 dB |
| conference_room_single_person | −1.44 dB |
| moving_speech_downward (elevation) | −3.90 dB |
| **Mean** | **≈ 0.00 dB** |

**Reading it:** tracked **wins on 4/7** — the multi-talker / mixed-posture
conference recordings, where a single static RTF is a poor fit. It loses on a
clean single static talker (batch is already ideal), the **planar-array-
unresolvable** elevation clip, and the aggressive synthetic sweep.

---

## 7. Why the array geometry matters (important caveat)

The Polaris UCA is **planar (z = 0)** → it has near-zero **elevation**
resolution. The dataset's real "moving" clips (`moving_*.wav`) move *downward*
(elevation), which the array essentially **cannot see**, so no estimator —
tracked or batch — can exploit that motion. Tracking only pays off for
**azimuth** motion (movement *around* the array). This is why a synthetic
azimuth-sweep test asset was created (§9).

---

## 8. Metric caveat (read before "tuning" anything)

The single-number `metrics_per_pipeline[...].snr_db` for the **tracked** slot is
**noisy and reference-dependent**: because its weights are time-varying, its
score swings ~10 dB depending on whether loud/quiet windows are labeled against
a single reference mic vs. the 8-channel mean. The point `snr_db` can even
disagree with the overall winner. **Always compare tracked variants by
`bootstrap_stats` median + win-rate, never the point `snr_db`.**

### Tuning dead-ends (don't re-explore — measured, rejected)
- **Linear RTF interpolation** between window centers (smooth steering instead
  of nearest-window): marginal and mixed — helped azimuth ~0.4 dB, hurt sitting.
  Not worth the complexity.
- **Shorter window `W=0.15 s`**: wins on sitting/azimuth but **overfits** — mean
  **−0.44 dB** across 7 clips vs **−0.00 dB** at `W=0.25`, due to ~−2 dB losses
  on the two-person clips. **`W=0.25` + nearest-assignment is the optimum.**

---

## 9. Code & test map

| Item | Location |
|---|---|
| Masked SCMs `Φ_x, Φ_v` | `compute_csm_masked` / `_compute_csm_masked_impl` |
| Batch RTF (cov-whitening) | `estimate_rtf` |
| Batch MVDR weights | `bf_mvdr` |
| **Windowed speech SCM** | `_windowed_speech_csm` |
| **Sliding-window tracked RTF** | `estimate_rtf_tracked` |
| Time-varying MVDR apply | `bf_mvdr_tracked` / `_bf_mvdr_tracked_spectrum` |
| Pipeline wiring (slot ⑤) | `process_file` (the `rtf_track = estimate_rtf_tracked(...)` call + `raw["RTF-MVDR (tracked)"]`) |
| Winner selection | `segment_metrics` → `bootstrap_compare` → `declare_winner` |
| Regression tests | `tests/test_sprint_b.py` (5 tests, all pass) |
| **Azimuth-sweep test asset** | `tests/make_azimuth_sweep.py` → `data/input/synth_azimuth_sweep.wav` |

**To test any future tracked-beamformer change:** run
`python tests/make_azimuth_sweep.py` (synthesizes a speaker sweeping
−90°→+90° in azimuth with a fixed interferer @135° — the only clip with
array-resolvable motion), then compare batch vs. tracked by **bootstrap
median + win-rate**.

---

## 10. Summary for a future Claude

- Batch and tracked RTF-MVDR share `compute_csm_masked` + the covariance-
  whitening `estimate_rtf`. Batch = one RTF; tracked = one RTF per frame.
- The MVDR formula is the same: `w = Φ_v⁻¹h / (hᴴΦ_v⁻¹h)`; tracked keeps `Φ_v`
  global and only varies `h(l,f)`.
- Tracked was upgraded from a noisy **per-frame PAST tracker** to a
  **sliding-window batch RTF** (`win_s=0.25`, `step_s=win_s/4`, nearest-window
  assignment). This is a strict improvement and is the tuned optimum.
- Tracked now genuinely wins on multi-talker / mixed-posture conference audio;
  batch still wins on clean single static talkers and on elevation motion the
  planar array can't resolve.
- Compare variants with bootstrap median + win-rate, not the noisy point
  `snr_db`. Interpolation and `W=0.15` were tried and rejected.

---

## 11. Choosing batch vs. tracked automatically (production path)

The instrument above tells you *which beam wins per clip*; the production
pipeline ([`prod_pipeline.py`](octovox_app/services/prod_pipeline.py)) has to
**decide live, per recording, without a bootstrap**. Two detectors feed the
`beam="auto"` choice:

- **SRP-PHAT spread** (`track_doa`, `movement="srp"`, default) — block-wise
  azimuth; reported as a readout but **not acted on**, because this UCA has a
  front/back ±180° ambiguity that swings the azimuth even for a static talker.
- **RTF drift** (`rtf_drift`, `movement="rtf"`) — measures how much the *RTF
  itself* (the quantity §2.3 / §4 steer with) changes block-to-block. It drops
  the onset-settling transition and fires on the **median of the steady
  transitions**, which requires *sustained* change. Being angle-free, it has
  none of the front/back ambiguity, so `auto` **does** act on it: sustained
  drift → tracked beam, else batch. Measured margin on this project's clips:
  every real/static recording sits at steady-median ≤ 0.01, while
  `synth_azimuth_sweep.wav` (§9's motion asset) sits at ~0.30 — so the default
  threshold is 0.12.

This matches §10's verdict (tracked wins on genuine motion, batch on static
talkers): RTF drift flags the sweep as moving and leaves every static clip on
batch. The trackers can additionally run on a **noise-robust, phase-preserving
speech-band copy** of the array (`condition_tracking_path`, the
"Noise-robust tracking" toggle) so HVAC/projector noise can't pull either
detector. Tests: `tests/test_prod_ports.py`.

---

## 12. Improving the MASK — spatial-coherence (ASA) cue

The covariances in §2.2 are only as good as the mask that splits speech from
noise T-F units, and `estimate_softmask` (§2.1) uses ONE cue: per-bin SNR. Worse,
it does `mag = |X|.mean(axis=2)` — it collapses the 8 mics to mono *before*
masking, so it is **blind to direction**. Auditory Scene Analysis (Bregman)
calls spatial location a primary grouping cue; `spatial_coherence(X)`
(prod_pipeline.py) recovers it: per T-F unit, the inter-mic magnitude-squared
coherence with the reference, smoothed over a small neighbourhood. ≈1 → one
directional source (speech); ≈0 → diffuse (late reverb, fan/HVAC). Fusing it
gently into the mask (`M·(0.9 + 0.1·coh)`) pushes diffuse energy into Φ_v.

**Measured (500-trial bootstrap, all 21 clips, seed-stable across 5 seeds):**
large wins on multi-talker / moving / reverberant clips (`two_person_talk_2`
**+11.8 dB**, `sitting_take2` +6.8, `take_3` +7.3, moving_* +4), mild losses on
already-clean single-talker close-mic clips (`fully_close` −3.1, `single_person`
−1.7). Mean **+1.8 dB**. The win/loss is NOT predicted by scene-mean coherence
(a simple gate fails), so the shipped mode is **`mask="auto"`**: build both the
SNR and coherent beams and keep whichever scores higher on an INDEPENDENT proxy
(`_mask_select_proxy` — output separation judged on mask-defined frames, not the
bootstrap's input-envelope frames). That keeps the full +1.8 dB mean while
cutting the worst case from −2.8 dB to **−0.5 dB** — never meaningfully worse
than baseline. Opt-in (`mask="snr"` default; `auto` runs the beamformer twice).
Only the **batch** beam is affected. Tests: `tests/test_prod_ports.py`.
