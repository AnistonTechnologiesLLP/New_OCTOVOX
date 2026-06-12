import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import {
  clearEntries,
  formatAll,
  getEntries,
  markSeen,
  subscribe,
  unseenCount,
} from '../../lib/errlog';
import { toast } from '../../state/toasts';

interface ErrlogUI {
  open: boolean;
  show: () => void;
  close: () => void;
  toggle: () => void;
}

export const useErrlogUI = create<ErrlogUI>((set, get) => ({
  open: false,
  show: () => {
    set({ open: true });
    markSeen();
  },
  close: () => set({ open: false }),
  toggle: () => (get().open ? get().close() : get().show()),
}));

export function useUnseenErrors(): number {
  return useSyncExternalStore(subscribe, unseenCount);
}

function copyAll(): void {
  const text = formatAll();
  const done = (): void => toast('Error log copied to clipboard');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text: string, done: () => void): void {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  } catch { /* clipboard unavailable */ }
}

export default function ErrorLogModal() {
  const open = useErrlogUI((s) => s.open);
  const close = useErrlogUI((s) => s.close);
  const entries = useSyncExternalStore(subscribe, getEntries);

  if (!open) return null;
  const items = entries.slice().reverse();

  return (
    <div className="errlog-root" role="dialog" aria-modal="true" aria-label="Error log">
      <div className="errlog-backdrop" onClick={close} />
      <div className="errlog-panel">
        <div className="errlog-head">
          <div className="errlog-title">
            Error log {items.length > 0 && <span className="errlog-count">{items.length}</span>}
          </div>
          <div className="errlog-actions">
            <button className="errlog-btn" title="Copy all entries" onClick={copyAll}>
              Copy
            </button>
            <button className="errlog-btn" title="Clear the log" onClick={clearEntries}>
              Clear
            </button>
            <button className="errlog-btn errlog-x" aria-label="Close" onClick={close}>
              ✕
            </button>
          </div>
        </div>
        <div className="errlog-list">
          {items.length === 0 ? (
            <div className="errlog-empty">No errors logged.</div>
          ) : (
            items.map((e, i) => {
              const t = new Date(e.ts);
              const cls = e.type === 'warn' ? 'warn' : 'error';
              return (
                <div key={`${e.ts}-${i}`} className={`errlog-item ${cls}`}>
                  <div className="errlog-item-top">
                    <span className={`errlog-tag errlog-tag-${cls}`}>{cls.toUpperCase()}</span>
                    <span className="errlog-msg">
                      {e.msg}
                      {e.count && e.count > 1 && <span className="errlog-mult"> ×{e.count}</span>}
                    </span>
                  </div>
                  <div className="errlog-meta">
                    {t.toLocaleTimeString()} / {t.toLocaleDateString()} /{' '}
                    <span className="errlog-where">{e.where}</span>
                  </div>
                  {e.detail && <pre className="errlog-detail">{e.detail}</pre>}
                </div>
              );
            })
          )}
        </div>
        <div className="errlog-foot">
          Local only / last 50 events / <kbd>E</kbd> opens this
        </div>
      </div>
    </div>
  );
}
