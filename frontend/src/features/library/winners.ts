/* /api/verdict winner map — the single map that drives (a) winner pills,
   (b) row status accents, (c) the "Recently cleaned" sort, and (d) the
   View-vs-Run action logic (legacy app.js:760-764). Field shapes verified
   against octovox_app/services/verdicts.py:54-60:
   { stem, winner, confidence, snr_db, duration_s }. */

import type { VerdictResult } from '../../lib/types';

export interface WinnerInfo {
  stem: string;
  winner: string;
  confidence: number;
}

/** Filename → stem, exactly like the legacy `.replace(/\.wav$/i, "")`. */
export function stemOf(name: string): string {
  return name.replace(/\.wav$/i, '');
}

export function buildWinnerMap(v: VerdictResult | undefined): Record<string, WinnerInfo> {
  const map: Record<string, WinnerInfo> = {};
  for (const r of v?.recordings ?? []) {
    if (!r.stem) continue;
    const w = r['winner'];
    const c = r['confidence'];
    map[r.stem] = {
      stem: r.stem,
      winner: typeof w === 'string' ? w : '',
      confidence: typeof c === 'number' ? c : 0,
    };
  }
  return map;
}
