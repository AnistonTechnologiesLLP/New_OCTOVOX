import { describe, it, expect } from 'vitest';
import {
  eyring,
  sabine,
  volume,
  surfaceArea,
  absorptionByBand,
  SABINE_CONSTANT,
} from '../acoustics/rt60';
import { InvalidRoomError, OCTAVE_BANDS, type Material, type RoomDimensions } from '../acoustics/types';

/** A fixture material with the same absorption coefficient in every band. */
const flat = (alpha: number): Material => ({
  name: `flat-${alpha}`,
  absorption: [alpha, alpha, alpha, alpha, alpha, alpha] as const,
});

const ROOM: RoomDimensions = { L: 5, W: 4, H: 3 };
/** Every surface assigned to the single fixture material id. */
const SURFACES = { floor: 'fix', ceiling: 'fix', walls: 'fix' } as const;

describe('geometry helpers', () => {
  it('computes volume V = L·W·H', () => {
    expect(volume(ROOM)).toBe(60);
  });

  it('computes surface area S = 2(LW + LH + WH)', () => {
    // 2(20 + 15 + 12) = 94
    expect(surfaceArea(ROOM)).toBe(94);
  });

  it('rejects non-positive dimensions', () => {
    expect(() => volume({ L: 0, W: 4, H: 3 })).toThrow(InvalidRoomError);
    expect(() => surfaceArea({ L: 5, W: -1, H: 3 })).toThrow(InvalidRoomError);
    expect(() => volume({ L: 5, W: 4, H: Number.NaN })).toThrow(InvalidRoomError);
  });
});

describe('absorptionByBand', () => {
  it('sums α·area across all surfaces per band', () => {
    // α = 0.1 on every surface ⇒ A = 0.1 · S = 0.1 · 94 = 9.4 for each band.
    const A = absorptionByBand(ROOM, SURFACES, { fix: flat(0.1) });
    expect(A).toHaveLength(OCTAVE_BANDS.length);
    for (const a of A) expect(a).toBeCloseTo(9.4, 10);
  });

  it('throws on an unknown material id', () => {
    expect(() =>
      absorptionByBand(ROOM, { floor: 'nope', ceiling: 'nope', walls: 'nope' }, { fix: flat(0.1) }),
    ).toThrow();
  });
});

describe('sabine — hand-computed sanity check', () => {
  it('matches RT60 = 0.161·V/A for a known room', () => {
    // V = 60, S = 94, α = 0.1 ⇒ A = 9.4 ⇒ RT60 = 0.161·60/9.4 = 1.027659… s
    const expected = (SABINE_CONSTANT * 60) / 9.4;
    expect(expected).toBeCloseTo(1.02766, 4);

    const result = sabine(ROOM, SURFACES, { fix: flat(0.1) });
    expect(result).toHaveLength(OCTAVE_BANDS.length);
    result.forEach((point, i) => {
      expect(point.band).toBe(OCTAVE_BANDS[i]);
      expect(point.rt60).toBeCloseTo(1.02766, 4);
    });
  });
});

describe('eyring', () => {
  it('returns one finite RT60 per octave band', () => {
    const result = eyring(ROOM, SURFACES, { fix: flat(0.2) });
    expect(result).toHaveLength(OCTAVE_BANDS.length);
    for (const p of result) {
      expect(Number.isFinite(p.rt60)).toBe(true);
      expect(p.rt60).toBeGreaterThan(0);
    }
  });

  it('predicts a shorter RT60 than Sabine in an absorptive room', () => {
    // Eyring's −ln(1−ā) correction makes it lower than Sabine whenever ā > 0.
    const e = eyring(ROOM, SURFACES, { fix: flat(0.4) });
    const s = sabine(ROOM, SURFACES, { fix: flat(0.4) });
    e.forEach((point, i) => {
      expect(point.rt60).toBeLessThan(s[i]!.rt60);
    });
  });

  it('falls back to Sabine (finite) when ā ≥ 1', () => {
    // α = 1 everywhere ⇒ ā = 1 ⇒ ln(1−ā) undefined ⇒ Sabine fallback.
    const e = eyring(ROOM, SURFACES, { fix: flat(1) });
    const s = sabine(ROOM, SURFACES, { fix: flat(1) });
    e.forEach((point, i) => {
      expect(Number.isFinite(point.rt60)).toBe(true);
      expect(point.rt60).toBeCloseTo(s[i]!.rt60, 10);
    });
  });

  it('agrees closely with Sabine for very low absorption', () => {
    // As ā → 0, −ln(1−ā) → ā, so Eyring → Sabine (from below: Eyring ≤ Sabine).
    const e = eyring(ROOM, SURFACES, { fix: flat(0.01) });
    const s = sabine(ROOM, SURFACES, { fix: flat(0.01) });
    e.forEach((point, i) => {
      const ratio = point.rt60 / s[i]!.rt60;
      expect(ratio).toBeLessThanOrEqual(1);
      expect(ratio).toBeGreaterThan(0.99); // within 1 % at α = 0.01
    });
  });
});
