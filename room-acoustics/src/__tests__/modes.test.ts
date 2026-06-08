import { describe, it, expect } from 'vitest';
import {
  axialModes,
  modesBelow,
  lowestMode,
  SPEED_OF_SOUND,
  DEFAULT_MODE_COUNT,
} from '../acoustics/modes';
import { InvalidRoomError, type RoomDimensions } from '../acoustics/types';

const ROOM: RoomDimensions = { L: 5, W: 4, H: 3 };

describe('axialModes', () => {
  it('computes f = (c/2)·n/d for every axis and harmonic', () => {
    const modes = axialModes(ROOM, { count: 1 });
    // n = 1: L→343/2/5=34.3, W→343/8=42.875, H→343/6=57.1667
    const byAxis = Object.fromEntries(modes.map((m) => [m.axis, m.freq]));
    expect(byAxis['L']).toBeCloseTo(34.3, 6);
    expect(byAxis['W']).toBeCloseTo(42.875, 6);
    expect(byAxis['H']).toBeCloseTo(57.16667, 4);
  });

  it('returns count·3 modes, ascending by frequency', () => {
    const modes = axialModes(ROOM);
    expect(modes).toHaveLength(DEFAULT_MODE_COUNT * 3);
    for (let i = 1; i < modes.length; i++) {
      expect(modes[i]!.freq).toBeGreaterThanOrEqual(modes[i - 1]!.freq);
    }
  });

  it('honours custom harmonic count and speed of sound', () => {
    const modes = axialModes(ROOM, { count: 2, speedOfSound: 340 });
    expect(modes).toHaveLength(6);
    // L, n=2 ⇒ 340/2 · 2/5 = 68
    const lAxis = modes.filter((m) => m.axis === 'L').map((m) => m.freq);
    expect(lAxis).toHaveLength(2);
    expect(lAxis[1]).toBeCloseTo(68, 6);
  });

  it('uses 343 m/s and 4 harmonics by default', () => {
    expect(SPEED_OF_SOUND).toBe(343);
    expect(DEFAULT_MODE_COUNT).toBe(4);
  });

  it('rejects invalid geometry and parameters', () => {
    expect(() => axialModes({ L: 0, W: 4, H: 3 })).toThrow(InvalidRoomError);
    expect(() => axialModes(ROOM, { count: 0 })).toThrow(RangeError);
    expect(() => axialModes(ROOM, { count: 2.5 })).toThrow(RangeError);
    expect(() => axialModes(ROOM, { speedOfSound: -1 })).toThrow(RangeError);
  });
});

describe('modesBelow', () => {
  it('keeps only modes under the cutoff (default 300 Hz)', () => {
    const modes = axialModes(ROOM, { count: 12 });
    const low = modesBelow(modes);
    expect(low.every((m) => m.freq < 300)).toBe(true);
    expect(low.length).toBeLessThan(modes.length);
  });

  it('respects a custom cutoff', () => {
    const modes = axialModes(ROOM);
    expect(modesBelow(modes, 40).every((m) => m.freq < 40)).toBe(true);
  });
});

describe('lowestMode', () => {
  it('returns the fundamental of the longest dimension', () => {
    const modes = axialModes(ROOM);
    const lowest = lowestMode(modes);
    expect(lowest).not.toBeNull();
    expect(lowest?.axis).toBe('L'); // L = 5 m is the longest ⇒ lowest frequency
    expect(lowest?.freq).toBeCloseTo(34.3, 6);
  });

  it('returns null for an empty list', () => {
    expect(lowestMode([])).toBeNull();
  });
});
