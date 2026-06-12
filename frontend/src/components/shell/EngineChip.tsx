/* Engine capability chip — wires the dormant legacy sidebar chip (#chipDeps,
   index.html:39-42, never updated by any JS) to real GET /api/env data
   (PORTING.md §6.2 / §7 DECISION). Renders "DFN3 · WPE · VAD" with the
   unavailable engines struck/dimmed; clicking opens a small detail popover
   (version, GPU, CPU cores, audio format). Hidden below 820 px (shell.css). */

import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

export default function EngineChip() {
  const env = useQuery({ queryKey: ['env'], queryFn: api.env, staleTime: 60_000 });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Esc. Esc is intercepted in the capture phase so
  // the shell's Esc cascade (modal → toast) doesn't also fire.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const d = env.data;
  if (!d) return null; // subtle: nothing until /api/env answers

  const segs = [
    { lab: 'DFN3', ok: d.has_dfn },
    { lab: 'WPE', ok: d.has_wpe },
    { lab: 'VAD', ok: d.has_vad },
  ];
  const gpu =
    d.has_cuda && d.gpu_name
      ? `${d.gpu_name}${d.gpu_mem_gb ? ` (${d.gpu_mem_gb} GB)` : ''}`
      : 'CPU only';

  // Tooltip is suppressed while the popover is open — the popover IS the
  // explanation (same rationale as ux.js:157).
  const tip = open ? {} : { 'data-ux-tip': 'Engine capabilities - click for details' };

  return (
    <div className="engine-chip-wrap" ref={rootRef}>
      <button
        type="button"
        className="engine-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        {...tip}
        onClick={() => setOpen((o) => !o)}
      >
        {segs.map((s, i) => (
          <Fragment key={s.lab}>
            {i > 0 && (
              <span className="engine-chip-sep" aria-hidden="true">
                ·
              </span>
            )}
            <span
              className={`engine-chip-seg${s.ok ? '' : ' off'}`}
              title={s.ok ? undefined : `${s.lab} unavailable on this server`}
            >
              {s.lab}
            </span>
          </Fragment>
        ))}
      </button>
      {open && (
        <div className="engine-pop" role="dialog" aria-label="Engine details">
          <div className="engine-pop-head">Engine</div>
          <div className="engine-pop-row">
            <span className="ep-key">Version</span>
            <span className="ep-val">{d.version}</span>
          </div>
          <div className="engine-pop-row">
            <span className="ep-key">GPU</span>
            <span className="ep-val">{gpu}</span>
          </div>
          <div className="engine-pop-row">
            <span className="ep-key">CPU cores</span>
            <span className="ep-val">{d.cpu_cores}</span>
          </div>
          <div className="engine-pop-row">
            <span className="ep-key">Format</span>
            <span className="ep-val">
              {d.fs_required / 1000} kHz / {d.n_ch} ch
            </span>
          </div>
          {segs.map((s) => (
            <div className="engine-pop-row" key={s.lab}>
              <span className="ep-key">{s.lab}</span>
              <span className={`ep-val${s.ok ? '' : ' off'}`}>
                {s.ok ? 'available' : 'not installed'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
