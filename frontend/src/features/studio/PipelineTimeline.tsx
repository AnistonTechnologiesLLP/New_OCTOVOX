/* Inline pipeline timeline — replaces the legacy modal-style progress block
   (showProgress/updateProgress, app.js:631-698) per PORTING.md §7: title, %,
   per-stage pending/active/done, the live message line, and a scrolling log
   tail (newest first, cap 20, `fresh` on the newest — app.js:684-692).

   Stage state machine ported from app.js:675-683: pills before the active
   one are done, the active one is active, later ones pending — plus the
   session's `reached` set so stages stay lit between events.

   Rendered only while a run is active AND this Studio view shows the running
   file (anywhere else the StickyProgress pill takes over). */

import { STREAM_STAGES } from '../../lib/constants';
import { useSession } from '../../state/session';

const stemOf = (name: string): string => name.replace(/\.wav$/i, '');

export default function PipelineTimeline({ stem }: { stem: string }) {
  const progress = useSession((s) => s.progress);
  const selectedFile = useSession((s) => s.selectedFile);

  if (!progress.active) return null;
  const runningStem = selectedFile ? stemOf(selectedFile) : null;
  if (runningStem && runningStem !== stem) return null; // StickyProgress covers it

  const pct = Math.max(0, Math.min(100, progress.pct));
  const activeIdx = STREAM_STAGES.findIndex((s) => s.id === progress.stage);
  const log = progress.log.slice(-20).reverse(); // newest first, cap 20

  return (
    <section className="card timeline" role="status" aria-live="polite" aria-label="Pipeline progress">
      <div className="timeline-head">
        <span className="timeline-title">{progress.title || 'Working...'}</span>
        <span className="timeline-pct">{Math.round(pct)}%</span>
      </div>
      <div className="timeline-bar">
        <div className="timeline-fill" style={{ width: `${pct}%` }} />
      </div>
      <ol className="timeline-steps">
        {STREAM_STAGES.map((st, i) => {
          const state =
            st.id === progress.stage
              ? 'active'
              : (activeIdx >= 0 && i < activeIdx) || progress.reached.includes(st.id)
                ? 'done'
                : '';
          return (
            <li key={st.id} className={`timeline-step${state ? ` ${state}` : ''}`}>
              <span className="step-dot" aria-hidden="true" />
              {st.label}
            </li>
          );
        })}
      </ol>
      <div className="timeline-msg">{progress.message || 'starting...'}</div>
      {log.length > 0 && (
        <div className="timeline-log">
          {log.map((line, i) => (
            <div key={`${progress.log.length}-${i}`} className={`line${i === 0 ? ' fresh' : ''}`}>
              {line}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
