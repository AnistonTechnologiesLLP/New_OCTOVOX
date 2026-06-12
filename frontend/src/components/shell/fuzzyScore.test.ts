/* Unit tests for the palette's subsequence fuzzy scorer — the function is a
   VERBATIM port of shell.js:152-163, so these expectations are hand-computed
   from the legacy formula: 100 + best*5 - first - (label.length - hits)*0.1. */

import { describe, expect, it } from 'vitest';
import { fuzzyScore } from './fuzzyScore';

describe('fuzzyScore', () => {
  it('returns 0 for an empty query (legacy: every action listed)', () => {
    expect(fuzzyScore('Go to Library', '')).toBe(0);
    expect(fuzzyScore('', '')).toBe(0);
  });

  it('returns -1 when the query is not a subsequence', () => {
    expect(fuzzyScore('Upload a WAV', 'xyz')).toBe(-1);
    expect(fuzzyScore('Re-run clean', 'rep')).toBe(-1); // r,e match; no p after
    expect(fuzzyScore('', 'a')).toBe(-1);
  });

  it('is case-insensitive on both sides', () => {
    expect(fuzzyScore('Toggle Theme', 'TT')).toBe(fuzzyScore('toggle theme', 'tt'));
  });

  it('scores a contiguous mid-label match: 100 + best*5 - first - miss*0.1', () => {
    // 'go to library' (len 13): 'lib' matches at 6..8, best run 3, hits 3
    // => 100 + 15 - 6 - (13-3)*0.1 = 108
    expect(fuzzyScore('Go to Library', 'lib')).toBeCloseTo(108, 6);
  });

  it('scores a gapped subsequence with the run reset', () => {
    // 'toggle theme' (len 12): 't' at 0, next 't' at 7 (run reset to 1)
    // => 100 + 1*5 - 0 - (12-2)*0.1 = 104
    expect(fuzzyScore('Toggle theme', 'tt')).toBeCloseTo(104, 6);
  });

  it('rewards contiguity (best-run bonus) and earliness (first-index penalty)', () => {
    // 'new recording' (len 13): 'rec' at 4..6 => 100 + 15 - 4 - 1.0 = 110
    expect(fuzzyScore('New recording', 'rec')).toBeCloseTo(110, 6);
    // 'open report' (len 11): 'rep' at 5..7 => 100 + 15 - 5 - 0.8 = 109.2
    expect(fuzzyScore('Open report', 'rep')).toBeCloseTo(109.2, 6);
    // an early match must outrank the same query matching deep in the label:
    // 'clean all files' => 108.7 vs 'download clean wav' => 99.4
    expect(fuzzyScore('Clean all files', 'cl')).toBeCloseTo(108.7, 6);
    expect(fuzzyScore('Download clean WAV', 'cl')).toBeCloseTo(99.4, 6);
    expect(fuzzyScore('Clean all files', 'cl')).toBeGreaterThan(
      fuzzyScore('Download clean WAV', 'cl'),
    );
  });

  it('matches a full-label query with zero length penalty', () => {
    // exact text: best = hits = len, first = 0 => 100 + len*5
    expect(fuzzyScore('abc', 'abc')).toBeCloseTo(115, 6);
  });
});
