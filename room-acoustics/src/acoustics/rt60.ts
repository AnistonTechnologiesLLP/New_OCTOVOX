import {
  OCTAVE_BANDS,
  assertValidDimensions,
  type Material,
  type RoomDimensions,
  type RT60Point,
  type SurfaceKey,
} from './types';
import { MATERIALS, type SurfaceAssignment } from './materials';

/**
 * Metric Sabine constant `0.161 = 24·ln(10)/c` with `c = 343 m/s`, in s·m⁻¹.
 * RT60 = 0.161 · V / A.
 */
export const SABINE_CONSTANT = 0.161;

/** The three surface groups, in iteration order. */
const SURFACE_KEYS: readonly SurfaceKey[] = ['floor', 'ceiling', 'walls'];

/** Geometric area (m²) of each lumped surface group for a shoebox room. */
interface SurfaceAreas {
  readonly floor: number;
  readonly ceiling: number;
  readonly walls: number;
}

/**
 * Compute the room volume.
 *
 * @param d - Room dimensions in metres.
 * @returns Volume `V = L·W·H`, in m³.
 */
export function volume(d: RoomDimensions): number {
  assertValidDimensions(d);
  return d.L * d.W * d.H;
}

/**
 * Compute the total interior surface area of the shoebox.
 *
 * @param d - Room dimensions in metres.
 * @returns Area `S = 2·(L·W + L·H + W·H)`, in m².
 */
export function surfaceArea(d: RoomDimensions): number {
  assertValidDimensions(d);
  return 2 * (d.L * d.W + d.L * d.H + d.W * d.H);
}

/** Area of each lumped surface group (floor = ceiling = L·W; walls = 2·(L·H + W·H)). */
function surfaceAreasOf(d: RoomDimensions): SurfaceAreas {
  return {
    floor: d.L * d.W,
    ceiling: d.L * d.W,
    walls: 2 * (d.L * d.H + d.W * d.H),
  };
}

/**
 * Total absorption (in metric Sabins, m²) per octave band:
 * `A_band = Σ_surface α_surface,band · area_surface`.
 *
 * @param d - Room dimensions in metres.
 * @param surfaces - Material id assigned to each surface group.
 * @param materials - Absorption database to resolve ids against.
 * @returns One absorption value per {@link OCTAVE_BANDS} entry.
 */
export function absorptionByBand(
  d: RoomDimensions,
  surfaces: Record<SurfaceKey, string>,
  materials: Record<string, Material>,
): number[] {
  const areas = surfaceAreasOf(d);
  return OCTAVE_BANDS.map((_band, i) => {
    let total = 0;
    for (const key of SURFACE_KEYS) {
      const id = surfaces[key];
      const material = materials[id];
      if (!material) {
        throw new Error(`Unknown material "${id}" assigned to ${key}.`);
      }
      total += (material.absorption[i] ?? 0) * areas[key];
    }
    return total;
  });
}

/**
 * Eyring reverberation time per octave band.
 *
 * `RT60 = 0.161 · V / (−S · ln(1 − ā))`, where `ā = A_band / S` is the mean
 * absorption coefficient. Air absorption is neglected (valid for small/mid
 * rooms). When `ā ≥ 1` the logarithm is undefined (a fully or over-absorptive
 * room), so this falls back to the {@link sabine} estimate for that band, which
 * stays finite.
 *
 * @param d - Room dimensions in metres.
 * @param surfaces - Material id per surface group (defaults resolve against {@link MATERIALS}).
 * @param materials - Optional absorption database for the supplied ids.
 * @returns RT60 (seconds) at each {@link OCTAVE_BANDS} centre frequency.
 */
export function eyring(d: RoomDimensions, surfaces: SurfaceAssignment): RT60Point[];
export function eyring<Id extends string>(
  d: RoomDimensions,
  surfaces: Record<SurfaceKey, Id>,
  materials: Record<Id, Material>,
): RT60Point[];
export function eyring(
  d: RoomDimensions,
  surfaces: Record<SurfaceKey, string>,
  materials: Record<string, Material> = MATERIALS,
): RT60Point[] {
  assertValidDimensions(d);
  const V = d.L * d.W * d.H;
  const S = 2 * (d.L * d.W + d.L * d.H + d.W * d.H);
  const A = absorptionByBand(d, surfaces, materials);
  return OCTAVE_BANDS.map((band, i) => {
    const aTotal = A[i] ?? 0;
    const aBar = aTotal / S;
    // ā ≥ 1 makes ln(1 − ā) ≤ 0 / undefined → fall back to Sabine for this band.
    const rt60 =
      aBar >= 1
        ? (SABINE_CONSTANT * V) / aTotal
        : (SABINE_CONSTANT * V) / (-S * Math.log(1 - aBar));
    return { band, rt60 };
  });
}

/**
 * Sabine reverberation time per octave band: `RT60 = 0.161 · V / A_band`.
 *
 * Simpler than {@link eyring} and always finite for non-zero absorption, but it
 * over-estimates RT60 in absorptive rooms (it lacks the `−ln(1 − ā)` correction).
 *
 * @param d - Room dimensions in metres.
 * @param surfaces - Material id per surface group (defaults resolve against {@link MATERIALS}).
 * @param materials - Optional absorption database for the supplied ids.
 * @returns RT60 (seconds) at each {@link OCTAVE_BANDS} centre frequency.
 */
export function sabine(d: RoomDimensions, surfaces: SurfaceAssignment): RT60Point[];
export function sabine<Id extends string>(
  d: RoomDimensions,
  surfaces: Record<SurfaceKey, Id>,
  materials: Record<Id, Material>,
): RT60Point[];
export function sabine(
  d: RoomDimensions,
  surfaces: Record<SurfaceKey, string>,
  materials: Record<string, Material> = MATERIALS,
): RT60Point[] {
  assertValidDimensions(d);
  const V = d.L * d.W * d.H;
  const A = absorptionByBand(d, surfaces, materials);
  return OCTAVE_BANDS.map((band, i) => ({
    band,
    rt60: (SABINE_CONSTANT * V) / (A[i] ?? 0),
  }));
}
