/* NDJSON streaming clean — 1:1 port of legacy cleanStreaming/cleanSynchronous
   (app.js:1541-1598) including the fallback contract:
     - transport failure before the stream opens  -> sync /api/clean
     - HTTP 404 (endpoint missing)                -> sync /api/clean
     - other non-OK                               -> error (json error field if present)
     - stream closed with zero events             -> sync /api/clean
     - stream closed with events but no done      -> error
*/

import type { CleanResult, ProdOpts, StreamEvent } from './types';

export type ProgressFn = (message: string, pct: number, stage?: string) => void;

/** Strip the "prod:" prefix for a tidier progress line (app.js:1601-1603). */
export function stripProdPrefix(msg: unknown): string {
  return String(msg ?? '').replace(/^prod:\s*/i, '');
}

async function cleanSynchronous(filename: string, opts: ProdOpts): Promise<CleanResult> {
  const r = await fetch('/api/clean', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, ...opts }),
  });
  const j = (await r.json()) as CleanResult & { error?: string };
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function cleanStreaming(
  filename: string,
  opts: ProdOpts,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<CleanResult> {
  let r: Response;
  try {
    r = await fetch('/api/clean_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, ...opts }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    return cleanSynchronous(filename, opts); // network/transport failure
  }
  if (!r.ok || !r.body) {
    if (r.status === 404) return cleanSynchronous(filename, opts);
    let msg = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as { error?: string };
      msg = j.error || msg;
    } catch { /* non-JSON error body — keep HTTP status message */ }
    throw new Error(msg);
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done: (StreamEvent & { type: 'done' }) | null = null;
  let gotAnyEvent = false;
  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: StreamEvent;
      try { ev = JSON.parse(line) as StreamEvent; } catch { continue; }
      gotAnyEvent = true;
      if (ev.type === 'progress') {
        onProgress(stripProdPrefix(ev.message), ev.pct, ev.stage);
      } else if (ev.type === 'error') {
        throw new Error(ev.message || 'pipeline error');
      } else if (ev.type === 'done') {
        done = ev;
      }
    }
  }
  if (done && done.ok) return done;
  // Stream closed without a usable result — fall back rather than fail silently.
  if (!gotAnyEvent) return cleanSynchronous(filename, opts);
  throw new Error('clean stream ended without a result');
}
