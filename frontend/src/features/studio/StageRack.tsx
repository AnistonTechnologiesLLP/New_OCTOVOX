/* Stage rack ("Signal chain" card) — ports renderProdStages (app.js:1907-1932)
   over the already-ported PROD_STAGE_LABELS formatters + STAGE_TIMING_KEY
   remap (lib/constants.ts): OK/SKIP mark, friendly label, per-stage detail
   (try/catch-guarded like legacy), wall-clock ms, and the SUM row
   (timings.TOTAL / 1000, 2 dp). Stages absent from the payload are omitted.

   NEW: a proportional horizontal timing bar per row (ms / max ms) so the
   slow stages jump out. Rendered only for a fresh CleanResult — re-views
   show the "re-run to refresh stage timings" hint in ResultsHeader instead. */

import { PROD_STAGE_LABELS, STAGE_TIMING_KEY } from '../../lib/constants';
import type { StageMap, Timings } from '../../lib/types';

interface Row {
  key: string;
  ran: boolean;
  label: string;
  detail: string;
  ms: number | undefined;
}

export default function StageRack({ stages, timings }: { stages: StageMap; timings: Timings }) {
  const rows: Row[] = Object.entries(PROD_STAGE_LABELS).flatMap(([key, view]) => {
    const s = stages[key];
    if (!s) return []; // stages absent from the payload are omitted
    let detail = '';
    try {
      detail = view.detail(s) || '';
    } catch {
      detail = '';
    }
    return [{ key, ran: !!s.ran, label: view.label, detail, ms: timings[STAGE_TIMING_KEY[key] ?? key] }];
  });
  const maxMs = rows.reduce((m, r) => (r.ms != null && r.ms > m ? r.ms : m), 0);
  const total = timings['TOTAL'];

  return (
    <section className="card stage-panel" aria-label="Signal chain">
      <div className="stage-panel-head">
        <h3 className="stage-panel-title">Signal chain</h3>
        <span className="muted">per-stage status &amp; wall-clock</span>
      </div>
      <div className="stage-rack">
        {rows.map((r) => (
          <div key={r.key} className={`prod-stage ${r.ran ? 'ran' : 'skip'}`}>
            <div className="psg-mark">{r.ran ? 'OK' : 'SKIP'}</div>
            <div className="psg-label">{r.label}</div>
            <div className="psg-detail" title={r.detail}>
              {r.detail}
            </div>
            <div className="psg-time">{r.ms != null ? `${r.ms} ms` : ''}</div>
            <div className="psg-bar" aria-hidden="true">
              {r.ms != null && maxMs > 0 && (
                <span
                  className="psg-bar-fill"
                  style={{ width: `${Math.max(1, (r.ms / maxMs) * 100)}%` }}
                />
              )}
            </div>
          </div>
        ))}
        <div className="prod-stage prod-stage-total">
          <div className="psg-mark">SUM</div>
          <div className="psg-label">Total</div>
          <div className="psg-detail" />
          <div className="psg-time">{total != null ? `${(total / 1000).toFixed(2)} s` : ''}</div>
          <div className="psg-bar" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
