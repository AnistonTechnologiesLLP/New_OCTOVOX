/* Unit tests for the A/B engine math (legacy contract: app.js:1786-1813).
   Fixtures are hand-computed — the constants under test (decimation step,
   TARGET 0.08, clamp [0.25, 4], 1e-5 silence floor) must stay verbatim. */

import { describe, expect, it } from 'vitest';
import { computeABGains, rmsOfBuffer, type DecodedBuffer } from './abEngine';

const buf = (data: Float32Array): DecodedBuffer => ({ getChannelData: () => data });

describe('rmsOfBuffer', () => {
  it('returns null when there is no decoded buffer', () => {
    expect(rmsOfBuffer(null)).toBeNull();
    expect(rmsOfBuffer(undefined)).toBeNull();
  });

  it('returns null for an empty channel (k = 0)', () => {
    expect(rmsOfBuffer(buf(new Float32Array(0)))).toBeNull();
  });

  it('returns null when reading the buffer throws (legacy try/catch)', () => {
    const broken = { getChannelData: (): Float32Array => { throw new Error('detached'); } };
    expect(rmsOfBuffer(broken)).toBeNull();
  });

  // Fixture values are dyadic (0.25, 0.5, 1.0) so they are exact in float32
  // and the hand-computed expectations hold to full double precision.
  it('computes the exact RMS of a short buffer (step = 1)', () => {
    // sqrt((0.25 + 0.25 + 0 + 0) / 4) = sqrt(0.125)
    expect(rmsOfBuffer(buf(new Float32Array([0.5, 0.5, 0, 0])))).toBeCloseTo(Math.sqrt(0.125), 10);
  });

  it('is sign-insensitive (squares the samples)', () => {
    expect(rmsOfBuffer(buf(new Float32Array([0.5, -0.5, 0.5, -0.5])))).toBeCloseTo(0.5, 10);
  });

  it('reads every sample below the 100k threshold (step stays 1)', () => {
    // length 99999 → step = max(1, floor(99999/50000)) = 1 → all samples read.
    const data = new Float32Array(99999).fill(0.5);
    data[1] = 1; // an odd index must contribute when step = 1
    const expected = Math.sqrt((0.25 * 99998 + 1) / 99999);
    expect(rmsOfBuffer(buf(data))).toBeCloseTo(expected, 10);
  });

  it('decimates with step = floor(len / 50000): odd samples skipped at 100k', () => {
    // length 100000 → step = 2 → reads indices 0,2,4,... (50000 even samples).
    const data = new Float32Array(100000);
    for (let i = 0; i < data.length; i++) data[i] = i % 2 === 0 ? 0.25 : 1.0;
    // Only the 0.25 even samples are read → RMS = 0.25 (1.0s never contribute).
    expect(rmsOfBuffer(buf(data))).toBeCloseTo(0.25, 10);
  });

  it('uses step = 3 at 150k samples (k = ceil(len / step))', () => {
    // length 150000 → step = 3 → indices 0,3,6,... (50000 samples).
    const data = new Float32Array(150000);
    for (let i = 0; i < data.length; i += 3) data[i] = 0.5; // read set
    // non-multiples of 3 stay 0 and are never read
    expect(rmsOfBuffer(buf(data))).toBeCloseTo(0.5, 10);
  });
});

describe('computeABGains', () => {
  it('is unity at exactly the TARGET RMS (0.08)', () => {
    expect(computeABGains(0.08, 0.08)).toEqual({ rawGain: 1, cleanGain: 1 });
  });

  it('computes independent make-up gains per side (TARGET / rms)', () => {
    // 0.08/0.04 = 2; 0.08/0.16 = 0.5 — both inside the clamp.
    const g = computeABGains(0.04, 0.16);
    expect(g.rawGain).toBeCloseTo(2, 10);
    expect(g.cleanGain).toBeCloseTo(0.5, 10);
  });

  it('clamps boost to 4 and cut to 0.25', () => {
    // 0.08/0.01 = 8 → 4; 0.08/0.64 = 0.125 → 0.25.
    const g = computeABGains(0.01, 0.64);
    expect(g.rawGain).toBe(4);
    expect(g.cleanGain).toBe(0.25);
  });

  it('returns unity for unknown or near-silent RMS (<= 1e-5)', () => {
    expect(computeABGains(null, null)).toEqual({ rawGain: 1, cleanGain: 1 });
    expect(computeABGains(0, 1e-5)).toEqual({ rawGain: 1, cleanGain: 1 });
  });

  it('applies the clamp just above the silence floor', () => {
    // 2e-5 is audible per the law: 0.08/2e-5 = 4000 → clamped to 4.
    const g = computeABGains(2e-5, 0.08);
    expect(g.rawGain).toBe(4);
    expect(g.cleanGain).toBe(1);
  });

  it('keeps an exact boundary value unclamped', () => {
    // 0.08/0.32 = 0.25 exactly — sits on the clamp floor.
    expect(computeABGains(0.32, 0.02).rawGain).toBeCloseTo(0.25, 10);
    expect(computeABGains(0.32, 0.02).cleanGain).toBe(4);
  });
});
