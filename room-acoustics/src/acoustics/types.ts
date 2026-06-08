/**
 * Shared domain types for the room-acoustics engine.
 *
 * Everything here is framework- and DOM-free so the engine can run in the
 * browser, on a server, and inside test runners unchanged.
 */

/** Standard six octave-band centre frequencies, in Hz. */
export const OCTAVE_BANDS = [125, 250, 500, 1000, 2000, 4000] as const;

/** The number of octave bands modelled (6). */
export const BAND_COUNT = OCTAVE_BANDS.length;

/**
 * Per-band values aligned 1:1 with {@link OCTAVE_BANDS} — a fixed-length tuple
 * so the type system guarantees one coefficient per band.
 */
export type BandValues = readonly [number, number, number, number, number, number];

/** A surface finish and its octave-band absorption coefficients (0..1, unitless). */
export interface Material {
  /** Human-readable label for UI display. */
  readonly name: string;
  /** Absorption coefficient per {@link OCTAVE_BANDS} entry. */
  readonly absorption: BandValues;
}

/** Internal room dimensions, in metres. */
export interface RoomDimensions {
  /** Length (m). */
  readonly L: number;
  /** Width (m). */
  readonly W: number;
  /** Height (m). */
  readonly H: number;
}

/** The three lumped surface groups a finish is assigned to. */
export type SurfaceKey = 'floor' | 'ceiling' | 'walls';

/** One RT60 value (seconds) at one octave-band centre frequency (Hz). */
export interface RT60Point {
  /** Octave-band centre frequency, in Hz. */
  readonly band: number;
  /** Reverberation time, in seconds. */
  readonly rt60: number;
}

/** Room axis a standing wave runs along. */
export type Axis = 'L' | 'W' | 'H';

/** One axial room mode (a standing wave between one pair of parallel surfaces). */
export interface RoomMode {
  /** Modal frequency, in Hz. */
  readonly freq: number;
  /** The axis the mode runs along. */
  readonly axis: Axis;
}

/** Thrown when room geometry is physically invalid (non-positive dimensions). */
export class InvalidRoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRoomError';
  }
}

/**
 * Throw {@link InvalidRoomError} unless every dimension is a positive, finite
 * number. Shared by the RT60 and mode calculators.
 *
 * @param dimensions - Candidate room dimensions in metres.
 */
export function assertValidDimensions(dimensions: RoomDimensions): void {
  for (const axis of ['L', 'W', 'H'] as const) {
    const value = dimensions[axis];
    if (!Number.isFinite(value) || value <= 0) {
      throw new InvalidRoomError(
        `Room dimension "${axis}" must be a positive, finite number (got ${value}).`,
      );
    }
  }
}
