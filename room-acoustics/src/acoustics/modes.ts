import {
  assertValidDimensions,
  type Axis,
  type RoomDimensions,
  type RoomMode,
} from './types';

/** Speed of sound in air at ~20 °C, in m/s. */
export const SPEED_OF_SOUND = 343;

/** Default number of harmonics per axis. */
export const DEFAULT_MODE_COUNT = 4;

/** Default cutoff for "problem" low-frequency modes, in Hz. */
export const DEFAULT_MODE_CUTOFF = 300;

/** Options for {@link axialModes}. */
export interface AxialModeOptions {
  /** Harmonics per axis, `n = 1..count` (default {@link DEFAULT_MODE_COUNT}). */
  readonly count?: number;
  /** Speed of sound in m/s (default {@link SPEED_OF_SOUND}). */
  readonly speedOfSound?: number;
}

/**
 * Compute axial room modes (standing waves between one pair of parallel walls)
 * for all three axes.
 *
 * For each axis of length `d` and harmonic `n`:
 * `f = (c / 2) · n / d`, in Hz.
 *
 * @param d - Room dimensions in metres.
 * @param options - Harmonic count and speed of sound.
 * @returns Modes for all three axes, ascending by frequency.
 */
export function axialModes(d: RoomDimensions, options: AxialModeOptions = {}): RoomMode[] {
  assertValidDimensions(d);
  const count = options.count ?? DEFAULT_MODE_COUNT;
  const c = options.speedOfSound ?? SPEED_OF_SOUND;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`Mode count must be a positive integer (got ${count}).`);
  }
  if (!Number.isFinite(c) || c <= 0) {
    throw new RangeError(`Speed of sound must be a positive, finite number (got ${c}).`);
  }

  const axes: ReadonlyArray<readonly [Axis, number]> = [
    ['L', d.L],
    ['W', d.W],
    ['H', d.H],
  ];

  const modes: RoomMode[] = [];
  for (const [axis, length] of axes) {
    for (let n = 1; n <= count; n++) {
      modes.push({ freq: (c / 2) * (n / length), axis });
    }
  }
  return modes.sort((a, b) => a.freq - b.freq);
}

/**
 * Filter modes below a cutoff — the band where axial modes are sparse and most
 * audible as bass build-up.
 *
 * @param modes - Modes to filter.
 * @param cutoff - Upper bound in Hz (default {@link DEFAULT_MODE_CUTOFF}).
 * @returns Modes with `freq < cutoff`, order preserved.
 */
export function modesBelow(
  modes: readonly RoomMode[],
  cutoff: number = DEFAULT_MODE_CUTOFF,
): RoomMode[] {
  return modes.filter((m) => m.freq < cutoff);
}

/**
 * Identify the lowest-frequency mode — the primary bass-buildup indicator (the
 * fundamental of the room's longest dimension).
 *
 * @param modes - Modes to scan (need not be sorted).
 * @returns The lowest mode, or `null` when the list is empty.
 */
export function lowestMode(modes: readonly RoomMode[]): RoomMode | null {
  return modes.reduce<RoomMode | null>(
    (lowest, mode) => (lowest === null || mode.freq < lowest.freq ? mode : lowest),
    null,
  );
}
