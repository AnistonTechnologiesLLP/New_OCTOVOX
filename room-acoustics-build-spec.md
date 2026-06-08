# Room Acoustics Estimation Module — Build Specification

**Target:** Claude Code
**Deliverable:** Production-grade, framework-agnostic TypeScript acoustics engine + React presentation layer
**Scope:** Software-only simulation (no physical mic/speaker capture)

---

## 1. Objective

Implement a standalone room-acoustics estimation feature for a web application. The system computes **RT60 (reverberation time)** and **axial room modes** from room geometry and surface materials, and provides an optional **auralization** preview via the Web Audio API.

The engine must be a **pure, DOM-free, fully typed TypeScript library** suitable for reuse across web, server-side rendering, and test environments. A thin React component consumes the engine for visualization.

---

## 2. Package Structure

```
src/
├── acoustics/
│   ├── materials.ts      # Absorption-coefficient database
│   ├── rt60.ts           # Eyring / Sabine reverberation calculations
│   ├── modes.ts          # Axial room-mode calculations
│   ├── auralize.ts       # Web Audio impulse-response synthesis
│   ├── types.ts          # Shared domain types
│   └── index.ts          # Public API surface
├── components/
│   └── RoomAcoustics.tsx # React UI wrapper (controls + charts)
└── __tests__/
    ├── rt60.test.ts
    ├── modes.test.ts
    └── materials.test.ts
```

---

## 3. Core Engine Requirements

The engine must consist of **pure functions** — no DOM access, no side effects, fully typed, and independently unit-testable. The React layer must remain a separate consumer; engine logic must never reach into rendering concerns.

### 3.1 `materials.ts` — Absorption Database

Export a strongly typed `MATERIALS` record. Each material maps to absorption coefficients across the six standard octave bands:

```
[125, 250, 500, 1000, 2000, 4000] Hz
```

**Required materials (minimum):**

| Material | Notes |
| --- | --- |
| Bare concrete / brick | Low absorption baseline |
| Painted plaster | Hard reflective surface |
| Gypsum drywall | Common partition |
| Carpet on concrete | Frequency-dependent floor |
| Heavy curtains | Mid/high absorber |
| Acoustic panel (50 mm) | High broadband absorber |
| Wood floor | Moderate reflector |
| Glass window | Low-frequency leak |
| Suspended ceiling tile | Broadband ceiling absorber |

Annotate the export with a `// TODO: replace with authoritative coefficient database` comment, since shipped values must eventually be sourced from a verified reference table.

### 3.2 `rt60.ts` — Reverberation Time

Given room dimensions `{ L, W, H }` in metres and a surface→material assignment `{ floor, ceiling, walls }`, compute per-band RT60.

**Primary method — Eyring:**

```
RT60 = 0.161 × V / (−S × ln(1 − ā))

where
  V  = room volume (m³)
  S  = total surface area (m²)
  ā  = total absorption (Sabins) / S
```

**Also expose** a `sabine()` variant: `RT60 = 0.161 × V / A`.

**Return shape:** `Array<{ band: number; rt60: number }>`.

**Edge-case handling (mandatory):**
- Reject zero or negative dimensions with a clear, typed error.
- When `ā ≥ 1` (Eyring `ln` blows up), clamp safely or fall back to Sabine, and document the chosen behaviour.

### 3.3 `modes.ts` — Axial Room Modes

Compute axial standing-wave frequencies:

```
f = (C / 2) × n / dimension      for n = 1..N      (default N = 4, C = 343 m/s)
```

Evaluate across all three dimensions. Return a sorted `Array<{ freq: number; axis: 'L' | 'W' | 'H' }>`. Provide a helper to filter below a configurable cutoff (default 300 Hz) and to identify the lowest mode (the primary bass-buildup indicator).

### 3.4 `auralize.ts` — Web Audio Preview

Given a target RT60 and an `AudioContext`:

1. Synthesize a **stereo impulse response** from decorrelated noise multiplied by an exponential decay that reaches −60 dB at the target RT60:
   ```
   decay = exp(−6.908 / (rt60 × sampleRate))
   ```
2. Build a short noise-burst source.
3. Route: `source → ConvolverNode → GainNode → destination`.
4. Return a promise that resolves when playback completes.
5. Guard against a suspended `AudioContext` by calling `resume()` first.

This module is the only one permitted to touch Web Audio APIs.

---

## 4. React Component — `RoomAcoustics.tsx`

A thin presentation layer over the engine. Rendering must stay decoupled from computation.

**Controls**
- Numeric inputs for length, width, height.
- Three material dropdowns (floor, ceiling, walls).
- Live recompute on any change.

**Display**
- RT60-vs-frequency bar chart, color-coded by value: `< 0.8 s` (optimal), `< 1.2 s` (lively), otherwise (reverberant).
- Axial-mode frequency plot.
- Headline metrics: 500 Hz RT60 with a descriptive label, room volume, and lowest mode.
- An **Auralize** action button.

Use a charting library of your choice (`recharts` is acceptable). Keep all rendering separate from engine code.

---

## 5. Quality Bar

This is a production upgrade. The following are non-negotiable acceptance criteria:

- **Strict TypeScript** throughout — no `any`.
- **Unit tests (Vitest)** for `rt60`, `modes`, and material lookups, including a known-volume sanity check validating output against a hand-computed Sabine value.
- **JSDoc** on every public function stating the formula and units.
- **`README.md`** documenting the public API, the formulas used, and an explicit **Limitations** section.

### Required Limitations Disclosure

The README must state plainly that this module:

- performs **statistical estimation for rectangular ("shoebox") rooms only**;
- does **not** model furniture, diffraction, scattering, or tangential/oblique modes;
- uses **representative, not authoritative**, absorption coefficients;
- is **not a substitute for measured impulse-response commissioning**.

---

## 6. Build Order

1. Implement the engine (`materials`, `types`, `rt60`, `modes`, `auralize`).
2. Write unit tests and confirm they pass.
3. Add the React presentation layer.
4. Write the `README.md`, including the limitations disclosure.

Do not begin the React layer until the engine tests pass.

---

## 7. Open Configuration

Before implementation, confirm or adapt the following to repository conventions:

- **Framework target** (Vite, Next.js, etc.) and the corresponding build/test config.
- **Charting library** preference.
- **Module format** (ESM-only vs. dual) and the public export surface in `index.ts`.
