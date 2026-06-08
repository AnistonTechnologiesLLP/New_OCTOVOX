/**
 * Public API surface of the room-acoustics engine.
 *
 * Pure, DOM-free RT60 + room-mode estimation (`rt60`, `modes`), the absorption
 * database (`materials`), shared types, and the optional Web Audio
 * auralization preview (`auralize`).
 */
export {
  OCTAVE_BANDS,
  BAND_COUNT,
  InvalidRoomError,
  assertValidDimensions,
  type BandValues,
  type Material,
  type RoomDimensions,
  type SurfaceKey,
  type RT60Point,
  type Axis,
  type RoomMode,
} from './types';

export {
  MATERIALS,
  MATERIAL_IDS,
  getMaterial,
  type MaterialId,
  type SurfaceAssignment,
} from './materials';

export {
  SABINE_CONSTANT,
  volume,
  surfaceArea,
  absorptionByBand,
  eyring,
  sabine,
  compareRT60,
  type MeasuredRT60Point,
  type RT60Comparison,
} from './rt60';

export {
  SPEED_OF_SOUND,
  DEFAULT_MODE_COUNT,
  DEFAULT_MODE_CUTOFF,
  axialModes,
  modesBelow,
  lowestMode,
  type AxialModeOptions,
} from './modes';

export { auralize, type AuralizeOptions } from './auralize';
