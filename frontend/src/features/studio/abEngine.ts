/* Level-matched A/B engine — the pure math, ported verbatim from the legacy
   A/B compare block (app.js:1778-1813). Both players run in lock-step from
   one playhead; only the SELECTED source is audible (the other is muted to
   volume 0). Each is loudness-normalized to a common RMS target so "sounds
   cleaner" can't be confused with "sounds louder".

   Magic numbers — byte-identical with legacy, do not touch (PORTING.md §4.4):
   - RMS decimation: sample up to ~50k points (step = floor(len / 50000))
   - TARGET = 0.08  (common RMS target, ~-22 dBFS)
   - make-up gain clamped to [0.25, 4]; rms <= 1e-5 (or unknown) → gain 1 */

/** The slice of a decoded AudioBuffer the engine reads (WaveSurfer's
 *  getDecodedData() return shape). */
export interface DecodedBuffer {
  getChannelData(channel: number): Float32Array;
}

/** app.js:1786-1797 — RMS of channel 0, decimated to at most ~50k samples
 *  for speed (RMS is stable on a decimated read). Returns null when the
 *  audio isn't decoded yet or the buffer is empty. */
export function rmsOfBuffer(buf: DecodedBuffer | null | undefined): number | null {
  try {
    if (!buf) return null;
    const ch = buf.getChannelData(0);
    // sample up to ~50k points for speed; RMS is stable on a decimated read
    const step = Math.max(1, Math.floor(ch.length / 50000));
    let sum = 0;
    let k = 0;
    for (let i = 0; i < ch.length; i += step) {
      const v = ch[i] ?? 0;
      sum += v * v;
      k++;
    }
    return k ? Math.sqrt(sum / k) : null;
  } catch {
    return null;
  }
}

export interface ABGains {
  rawGain: number;
  cleanGain: number;
}

/** app.js:1804-1813 — gain law. TARGET = 0.08 (~-22 dBFS); cap make-up gain
 *  so a near-silent file can't blast (max 4); floor avoids /0 (min 0.25);
 *  rms <= 1e-5 or unknown → unity gain. */
export function computeABGains(rRaw: number | null, rClean: number | null): ABGains {
  const TARGET = 0.08; // common RMS target (~-22 dBFS)
  // Cap make-up gain so a near-silent file can't blast; floor avoids /0.
  const g = (r: number | null): number =>
    r != null && r > 1e-5 ? Math.min(4, Math.max(0.25, TARGET / r)) : 1;
  return { rawGain: g(rRaw), cleanGain: g(rClean) };
}
