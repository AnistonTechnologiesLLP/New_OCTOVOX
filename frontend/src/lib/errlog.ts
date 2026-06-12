/* In-app error log — port of octovox_app/static/errlog.js (ring buffer,
   localStorage mirror, unseen badge). Capture surface: window 'error',
   'unhandledrejection', console.error/warn wraps, and failed /api/ requests
   (tapped by lib/api.ts instead of wrapping window.fetch). Local-only. */

const MAX = 50;
const KEY = 'octovox.errorlog.v1';
const SEEN_KEY = 'octovox.errorlog.seen.v1';

export interface ErrEntry {
  ts: number;
  type: 'error' | 'warn';
  msg: string;
  detail: string;
  where: string;
  count?: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let items: ErrEntry[] = [];

function lsGet(k: string, d: string): string {
  try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; }
}
function lsSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* quota/denied — log stays in-memory */ }
}

function load(): void {
  try { items = (JSON.parse(lsGet(KEY, '[]')) as ErrEntry[]) || []; } catch { items = []; }
}
function save(): void { lsSet(KEY, JSON.stringify(items.slice(-MAX))); }
function notify(): void { listeners.forEach((l) => l()); }

function currentWhere(): string {
  return (location.hash || '').replace(/^#\//, '').split('/')[0] || 'library';
}

export function record(type: 'error' | 'warn', msg: unknown, detail?: unknown): void {
  if (!msg) return;
  try {
    const entry: ErrEntry = {
      ts: Date.now(),
      type,
      msg: String(msg).slice(0, 600),
      detail: detail ? String(detail).slice(0, 2000) : '',
      where: currentWhere(),
    };
    // de-dupe a burst of the identical message within 1.5 s (e.g. retried fetch)
    const last = items[items.length - 1];
    if (last && last.msg === entry.msg && entry.ts - last.ts < 1500) {
      last.count = (last.count || 1) + 1;
      last.ts = entry.ts;
    } else {
      items.push(entry);
      if (items.length > MAX) items = items.slice(-MAX);
    }
    save();
    notify();
  } catch { /* never let logging throw */ }
}

export function getEntries(): ErrEntry[] { return items; }
export function clearEntries(): void { items = []; save(); notify(); }
export function unseenCount(): number {
  const seen = Number(lsGet(SEEN_KEY, '0')) || 0;
  return items.filter((e) => e.ts > seen).length;
}
export function markSeen(): void { lsSet(SEEN_KEY, String(Date.now())); notify(); }
export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function formatAll(): string {
  return items
    .map((e) => {
      const ts = new Date(e.ts).toISOString();
      return (
        `[${ts}] ${e.type.toUpperCase()} (${e.where})${e.count && e.count > 1 ? ` x${e.count}` : ''}: ${e.msg}` +
        (e.detail ? `\n    ${e.detail.replace(/\n/g, '\n    ')}` : '')
      );
    })
    .join('\n');
}

let installed = false;
/** Install the global capture hooks once (window errors + console wraps). */
export function installErrorHooks(): void {
  if (installed) return;
  installed = true;
  load();

  window.addEventListener('error', (e) => {
    const err = e.error as Error | undefined;
    record('error', e.message || 'Uncaught error',
      err && err.stack ? err.stack : e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined;
    record('error', (r && r.message) || String(r || 'Unhandled rejection'), (r && r.stack) || '');
  });

  (['error', 'warn'] as const).forEach((level) => {
    const orig = console[level] ? console[level].bind(console) : () => undefined;
    console[level] = (...args: unknown[]) => {
      orig(...args);
      try {
        const msg = args
          .map((a) => {
            const m = a as { message?: string };
            if (m && m.message) return m.message;
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
            return String(a);
          })
          .join(' ');
        if (!/\[errlog\]/.test(msg)) {
          const withStack = args.find((a) => (a as { stack?: string })?.stack) as { stack?: string } | undefined;
          record(level === 'warn' ? 'warn' : 'error', msg, withStack?.stack || '');
        }
      } catch { /* never recurse */ }
    };
  });
}
