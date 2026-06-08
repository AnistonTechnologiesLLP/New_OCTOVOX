# Room Acoustics Estimation Module

A pure, framework-agnostic **TypeScript** engine that estimates **RT60
(reverberation time)** and **axial room modes** from room geometry and surface
materials, with an optional **Web Audio auralization** preview and a thin
**React** presentation layer.

The engine (`src/acoustics/`) is DOM-free and side-effect-free, so it runs
unchanged in the browser, on a server, and in test runners. The React component
(`src/components/RoomAcoustics.tsx`) is a separate consumer — no acoustics math
lives in the rendering layer.

---

## Install & scripts

```bash
npm install
npm test          # Vitest engine tests
npm run typecheck # strict tsc, no emit
npm run dev       # Vite dev server (served under /static/acoustics/ — see note)
npm run build     # typecheck + bundle → ../octovox_app/static/acoustics/
```

### Embedded in OCTOVOX

This module is also surfaced inside the OCTOVOX Flask app. `npm run build`
emits the bundle into `../octovox_app/static/acoustics/` with an absolute
`base` of `/static/acoustics/` (see `vite.config.ts`), and Flask serves the page
at **`/acoustics`** (route in `octovox_app/routes/pages.py`, reachable from the
top-bar **Acoustics ↗** link). The built bundle is committed so the page works
without a build step — **re-run `npm run build` after changing anything here**
to refresh it. The dev server (`npm run dev`) runs under the same `base`, i.e.
`http://localhost:5173/static/acoustics/`.

### Measured-vs-predicted bridge

When served inside OCTOVOX, the RT60 chart gains a *Compare with a recording*
control: it lists OCTOVOX input files (`GET /api/list_input`), and **Measure
RT60** calls `POST /api/rt60` to blind-estimate the room's *measured* RT60 from
that recording (free-decay Schroeder, server-side). The measured curve is
overlaid on the predicted bars and `compareRT60` drives a per-band delta strip.
This panel **auto-hides when those endpoints aren't reachable** (standalone dev),
so the engine and UI remain self-contained. The engine itself never calls the
network — only the React layer does, and only opportunistically.

---

## Public API

Everything is re-exported from `src/acoustics/index.ts`:

```ts
import {
  // RT60
  eyring, sabine, volume, surfaceArea, absorptionByBand, SABINE_CONSTANT,
  // Modes
  axialModes, modesBelow, lowestMode,
  SPEED_OF_SOUND, DEFAULT_MODE_COUNT, DEFAULT_MODE_CUTOFF,
  // Materials
  MATERIALS, MATERIAL_IDS, getMaterial,
  // Auralization (browser only)
  auralize,
  // Types & errors
  OCTAVE_BANDS, BAND_COUNT, InvalidRoomError, assertValidDimensions,
  type RoomDimensions, type SurfaceAssignment, type MaterialId,
  type RT60Point, type RoomMode, type Axis, type Material, type BandValues,
} from './acoustics';
```

### RT60 — `rt60.ts`

| Function | Signature | Returns |
| --- | --- | --- |
| `eyring` | `(d, surfaces, materials?)` | `RT60Point[]` (one per octave band) |
| `sabine` | `(d, surfaces, materials?)` | `RT60Point[]` |
| `volume` | `(d)` | `number` — `V = L·W·H` (m³) |
| `surfaceArea` | `(d)` | `number` — `S = 2(LW+LH+WH)` (m²) |
| `absorptionByBand` | `(d, surfaces, materials)` | `number[]` — total Sabins per band |
| `compareRT60` | `(predicted, measured)` | `RT60Comparison[]` — joins predicted + measured by band with a signed `deltaSec` |

```ts
const rt60 = eyring({ L: 5, W: 4, H: 3 }, { floor: 'carpet', ceiling: 'ceilingTile', walls: 'drywall' });
// → [{ band: 125, rt60: … }, … , { band: 4000, rt60: … }]
```

Both `eyring` and `sabine` default to the built-in `MATERIALS` database; pass a
third argument to resolve custom material ids (this is how the tests inject
known fixtures).

### Modes — `modes.ts`

| Function | Signature | Returns |
| --- | --- | --- |
| `axialModes` | `(d, { count?, speedOfSound? })` | `RoomMode[]` ascending by frequency |
| `modesBelow` | `(modes, cutoff = 300)` | `RoomMode[]` with `freq < cutoff` |
| `lowestMode` | `(modes)` | `RoomMode \| null` |

### Auralization — `auralize.ts` (browser only)

```ts
await auralize(new AudioContext(), rt60AtTargetBand /* seconds */);
```

The only module that touches Web Audio. Resolves when playback completes.

---

## Formulas & units

All lengths are **metres**, areas **m²**, volume **m³**, frequencies **Hz**, and
RT60 **seconds**. Octave bands are `[125, 250, 500, 1000, 2000, 4000] Hz`.

**Eyring (primary):**

```
RT60 = 0.161 · V / (−S · ln(1 − ā))      ā = A_band / S
```

**Sabine (also exposed):**

```
RT60 = 0.161 · V / A_band
```

where `A_band = Σ_surface α(surface, band) · area(surface)`, with floor and
ceiling areas `L·W` each and wall area `2·(L·H + W·H)`. The `0.161` constant is
the metric Sabine constant (`24·ln(10)/c`, `c = 343 m/s`); **air absorption is
neglected**.

**Edge cases (engine behaviour):**

- **Non-positive or non-finite dimensions** throw `InvalidRoomError`.
- **`ā ≥ 1`** (a fully/over-absorptive room) makes Eyring's `ln(1 − ā)`
  undefined, so that band **falls back to the Sabine estimate**, which stays
  finite. With zero absorption both methods correctly tend to infinity.

**Axial modes:**

```
f = (c / 2) · n / d        n = 1..count (default 4),  c = 343 m/s
```

evaluated on all three dimensions. The lowest mode is the fundamental of the
longest dimension — the primary bass-buildup indicator.

**Auralization decay** (per-sample IR envelope multiplier):

```
decay = exp(−6.908 / (rt60 · sampleRate))
```

`ln(10⁻³) = −6.908`, so the envelope reaches exactly −60 dB at `rt60` seconds.

---

## Materials

`MATERIALS` provides the nine finishes below, each with six octave-band
absorption coefficients. The values are **representative**, not certified.

`concrete`, `plaster`, `drywall`, `carpet`, `curtains`, `acousticPanel`,
`woodFloor`, `glass`, `ceilingTile`.

> The source carries a `// TODO: replace with authoritative coefficient database`
> marker — shipped values should eventually come from a verified reference table.

---

## Limitations

This module is a **screening tool**, not a measurement. Specifically, it:

- performs **statistical estimation for rectangular ("shoebox") rooms only**;
- does **not** model furniture, occupancy, diffraction, scattering, or
  **tangential/oblique modes** (only the three axial mode families);
- neglects **air absorption** and frequency-dependent edge effects;
- uses **representative, not authoritative**, absorption coefficients
  (see the `TODO` in `materials.ts`);
- is **not a substitute for measured impulse-response commissioning**.

The optional **measured** RT60 (via OCTOVOX `/api/rt60`) is a *blind* estimate
from running sound — it depends on the recording containing audible free decays,
is mildly biased low at low frequencies, and is itself **not** a swept-sine
measurement. Treat the predicted-vs-measured comparison as indicative.

Treat the numbers as ballpark guidance for early design decisions, and verify
critical spaces with a real in-room measurement.

---

## Testing

`npm test` runs the Vitest suite (`src/__tests__/`):

- **`rt60.test.ts`** — geometry helpers, per-band absorption, a **hand-computed
  Sabine sanity check** (`V = 60 m³`, `S = 94 m²`, `α = 0.1` → `RT60 =
  0.161·60/9.4 ≈ 1.028 s`), Eyring < Sabine in absorptive rooms, the `ā ≥ 1`
  Sabine fallback, and Eyring→Sabine convergence at low absorption.
- **`modes.test.ts`** — modal frequencies, sort order, cutoff filtering, the
  lowest-mode helper, and parameter/geometry validation.
- **`materials.test.ts`** — presence of every required material, six bands each,
  and coefficients within `[0, 1]`.
