/* Results header — ports renderProduction's headline block + buttons
   (app.js:1606-1640) and the showResults re-view variant (app.js:1706-1719).

   Fresh result (result != null): file meta (duration / kHz / ch from
   stages.mic_capsules), output title ("Clean voice" or "Speaker @ ±N deg"
   when beamform ran extract_direction), chain line via buildChainText,
   headline stats (elapsed, stages ran/total, RTF = elapsed / duration), and
   the Report button gated on j.report — no path guessing (app.js:1624-1627).

   Re-view (result == null): "re-run to refresh stage timings" hint, and the
   Report button enabled only when a HEAD probe of /output/<stem>/report.html
   succeeds — a sanctioned DECISION replacing the legacy 404-guess at
   app.js:1714 (see PORTING.md §4.2). */

import { useEffect, useState } from 'react';
import { useCleanRun } from '../../hooks/useCleanStream';
import { buildChainText } from '../../lib/constants';
import type { CleanResult } from '../../lib/types';
import { useSession } from '../../state/session';
import { toast } from '../../state/toasts';

export default function ResultsHeader({ stem, result }: { stem: string; result: CleanResult | null }) {
  const runClean = useCleanRun();
  const busy = useSession((s) => s.busy);
  const [probedReport, setProbedReport] = useState<string | null>(null);

  // Re-view report probe (DECISION): legacy pointed the button at the report
  // path without knowing whether one exists (app.js:1714) and let it 404 —
  // here a HEAD probe enables the button only when the file is really there.
  useEffect(() => {
    if (result) return undefined; // fresh runs gate on j.report instead
    let alive = true;
    setProbedReport(null);
    const url = `/output/${stem}/report.html`;
    fetch(url, { method: 'HEAD' })
      .then((r) => {
        if (alive && r.ok) setProbedReport(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [stem, result]);

  const reportUrl = result ? result.report : probedReport;
  const cleanUrl = result ? result.clean : `/output/${stem}/clean_prod.wav`;

  // Headline stats (app.js:1612-1621).
  const dur = result ? Number(result.stages['mic_capsules']?.duration_s ?? 0) : 0;
  const ran = result ? Object.values(result.stages).filter((s) => s && s.ran).length : 0;
  const total = result ? Object.keys(result.stages).length : 0;
  const rtf = result && dur > 0 ? result.elapsed_s / dur : 0;

  // Output title (app.js:1633-1639).
  const bf = (result?.stages['beamform'] ?? {}) as { method?: string; target_az?: number };
  const targeted = bf.method === 'extract_direction' && bf.target_az != null;
  const title =
    targeted && bf.target_az != null
      ? `Speaker @ ${bf.target_az > 0 ? '+' : ''}${bf.target_az} deg`
      : 'Clean voice';

  return (
    <section className="card results-head" aria-label="Results">
      <div className="results-title-row">
        <div className="results-title-stack">
          <h2 className="results-title">{title}</h2>
          {result ? (
            <div className="results-meta">
              {dur.toFixed(1)} s / {result.sr / 1000} kHz / {result.n_channels} ch
            </div>
          ) : (
            <div className="results-meta muted">re-run to refresh stage timings</div>
          )}
        </div>
        <div className="results-actions">
          <button
            type="button"
            className="btn"
            title="Download the clean WAV"
            onClick={() => {
              window.location.href = cleanUrl;
            }}
          >
            Download
          </button>
          <button
            type="button"
            className="btn"
            title={reportUrl ? 'Open the HTML report in a new tab' : 'No report for this run'}
            {...(reportUrl ? {} : { 'data-disabled': '' })}
            onClick={() => {
              // setReportButton semantics (app.js:1694-1704)
              if (reportUrl) window.open(reportUrl, '_blank', 'noopener');
              else toast('No report for this run.', 'warn');
            }}
          >
            Report
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            title={`Re-run the clean pipeline on ${stem}.wav`}
            onClick={() => void runClean(`${stem}.wav`)}
          >
            Re-run
          </button>
        </div>
      </div>

      {result && (
        <>
          <div className="results-chain" title="Signal chain this pass actually ran">
            {buildChainText(result)}
          </div>
          <div className="results-stats">
            <div className="ws-stat">
              <span className="ws-stat-val">{result.elapsed_s}s</span>
              <span className="ws-stat-lab">elapsed</span>
            </div>
            <div className="ws-stat">
              <span className="ws-stat-val">
                {ran}/{total}
              </span>
              <span className="ws-stat-lab">stages ran</span>
            </div>
            <div className="ws-stat">
              <span className="ws-stat-val">{rtf ? `${rtf.toFixed(2)}x` : '-'}</span>
              <span className="ws-stat-lab">RTF</span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
