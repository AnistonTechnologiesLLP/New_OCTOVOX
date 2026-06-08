import { describe, it, expect } from 'vitest';
import { compareRT60, type MeasuredRT60Point } from '../acoustics/rt60';
import type { RT60Point } from '../acoustics/types';

const predicted: RT60Point[] = [
  { band: 125, rt60: 0.9 },
  { band: 250, rt60: 0.8 },
  { band: 500, rt60: 0.7 },
];

describe('compareRT60', () => {
  it('joins predicted and measured by band with a signed seconds delta', () => {
    const measured: MeasuredRT60Point[] = [
      { band: 125, rt60: 1.1 },
      { band: 250, rt60: 0.6 },
      { band: 500, rt60: 0.7 },
    ];
    const cmp = compareRT60(predicted, measured);
    expect(cmp).toHaveLength(3);
    expect(cmp[0]).toEqual({ band: 125, predicted: 0.9, measured: 1.1, deltaSec: expect.closeTo(0.2, 10) });
    expect(cmp[1]?.deltaSec).toBeCloseTo(-0.2, 10);
    expect(cmp[2]?.deltaSec).toBeCloseTo(0, 10);
  });

  it('keeps predicted order and reports null for unmeasured bands', () => {
    const measured: MeasuredRT60Point[] = [
      { band: 250, rt60: null },
      { band: 500, rt60: 0.5 },
      // 125 absent entirely
    ];
    const cmp = compareRT60(predicted, measured);
    expect(cmp.map((c) => c.band)).toEqual([125, 250, 500]);
    expect(cmp[0]).toMatchObject({ band: 125, measured: null, deltaSec: null });
    expect(cmp[1]).toMatchObject({ band: 250, measured: null, deltaSec: null });
    expect(cmp[2]).toMatchObject({ band: 500, measured: 0.5, deltaSec: expect.closeTo(-0.2, 10) });
  });

  it('returns predicted-only rows when nothing was measured', () => {
    const cmp = compareRT60(predicted, []);
    expect(cmp.every((c) => c.measured === null && c.deltaSec === null)).toBe(true);
    expect(cmp.map((c) => c.predicted)).toEqual([0.9, 0.8, 0.7]);
  });
});
