import type { Material, SurfaceKey } from './types';

/**
 * Absorption-coefficient database, keyed by a stable material id. Each entry
 * lists the sound-absorption coefficient (0 = perfect reflector, 1 = perfect
 * absorber) for the six octave bands `[125, 250, 500, 1000, 2000, 4000] Hz`.
 *
 * Values are **representative** figures typical of architectural-acoustics
 * tables, chosen to give plausible relative behaviour — they are not a
 * certified reference and must not be used for commissioning.
 *
 * TODO: replace with authoritative coefficient database.
 */
export const MATERIALS = {
  concrete: {
    name: 'Bare concrete / brick',
    absorption: [0.01, 0.01, 0.02, 0.02, 0.02, 0.03],
  },
  plaster: {
    name: 'Painted plaster',
    absorption: [0.01, 0.01, 0.02, 0.02, 0.02, 0.02],
  },
  drywall: {
    name: 'Gypsum drywall',
    absorption: [0.29, 0.1, 0.05, 0.04, 0.07, 0.09],
  },
  carpet: {
    name: 'Carpet on concrete',
    absorption: [0.02, 0.06, 0.14, 0.37, 0.6, 0.65],
  },
  curtains: {
    name: 'Heavy curtains',
    absorption: [0.07, 0.31, 0.49, 0.75, 0.7, 0.6],
  },
  acousticPanel: {
    name: 'Acoustic panel (50 mm)',
    absorption: [0.2, 0.55, 0.85, 0.95, 0.92, 0.88],
  },
  woodFloor: {
    name: 'Wood floor',
    absorption: [0.15, 0.11, 0.1, 0.07, 0.06, 0.07],
  },
  glass: {
    name: 'Glass window',
    absorption: [0.35, 0.25, 0.18, 0.12, 0.07, 0.04],
  },
  ceilingTile: {
    name: 'Suspended ceiling tile',
    absorption: [0.5, 0.6, 0.65, 0.75, 0.8, 0.8],
  },
} as const satisfies Record<string, Material>;

/** Union of valid material ids — derived from {@link MATERIALS} so the two can't drift. */
export type MaterialId = keyof typeof MATERIALS;

/** A finish assignment for the three lumped surface groups of a room. */
export type SurfaceAssignment = Readonly<Record<SurfaceKey, MaterialId>>;

/** Every material id, handy for populating UI dropdowns. */
export const MATERIAL_IDS = Object.keys(MATERIALS) as MaterialId[];

/**
 * Look a material up by id.
 *
 * @param id - A {@link MaterialId} key.
 * @returns The {@link Material} record for that id.
 */
export function getMaterial(id: MaterialId): Material {
  return MATERIALS[id];
}
