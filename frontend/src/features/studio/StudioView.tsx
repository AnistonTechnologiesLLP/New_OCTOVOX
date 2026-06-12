/* Studio master-detail — Part 2 complete: results header, level-matched A/B
   players, inline pipeline timeline, stage rack, playout.
   Layout: FileRail (desktop-only) | detail pane | SettingsPanel.

   Two modes (PORTING.md §4.2):
   - fresh result (session.currentResult matches the viewed stem): full set —
     header stats + chain, A/B from j.input / j.clean, timeline while running,
     stage rack, playout (renderProduction, app.js:1606-1652)
   - re-view (results exist on disk but no result in the session): header in
     re-view mode + A/B from /output/<stem>/ WAVs + playout — no stage rack
     (showResults, app.js:1706-1719) */

import { useEffect, useMemo, useRef } from 'react';
import ABCompare from './ABCompare';
import FileRail from './FileRail';
import PipelineTimeline from './PipelineTimeline';
import PlayoutBar from './PlayoutBar';
import ResultsHeader from './ResultsHeader';
import SettingsPanel from './SettingsPanel';
import StageRack from './StageRack';
import { selectCaptureTab } from '../capture/CaptureDrawer';
import { goLibrary, openCapture } from '../../hooks/useHashRoute';
import type { ProdOpts } from '../../lib/types';
import { useSession } from '../../state/session';
import { getProdOpts } from '../../state/settings';
import './studio.css';

/** opthLabel (app.js:1686-1690) — the clean track's options sublabel. */
function opthLabel(o: ProdOpts): string {
  const dv = o.dereverb && o.dereverb !== 'none' ? ` / derev:${o.dereverb}` : '';
  const tgt = o.target_az != null ? ` / target ${o.target_az} deg` : '';
  return `NR:${o.nr}${dv} / beam:${o.beam}${o.eq ? ' / EQ' : ''}${tgt}`;
}

export default function StudioView({ stem }: { stem: string | null }) {
  const currentStem = useSession((s) => s.currentStem);
  const currentResult = useSession((s) => s.currentResult);
  // Plain #/studio falls back to the last cleaned stem (legacy Studio shows
  // the last result; only a truly fresh session gets the empty state).
  const viewStem = stem ?? currentStem;

  // Deep link (#/studio/:stem): make the rest of the app agree on the stem
  // (Studio gate, command palette, sticky-progress comparisons).
  useEffect(() => {
    if (stem && useSession.getState().currentStem !== stem) {
      useSession.getState().setStem(stem);
    }
  }, [stem]);

  // Fresh result vs re-view: only a result for THIS stem counts as fresh.
  const fresh = currentResult && viewStem && currentResult.stem === viewStem ? currentResult : null;

  // A re-run of the same stem returns the SAME /output URLs with new audio
  // behind them — legacy destroyed + recreated both players on every render
  // (app.js:1723-1724). Bump a sequence per result object so the A/B pair
  // remounts (and re-fetches/decodes) for every run, not just per stem.
  const runSeq = useRef(0);
  const lastResult = useRef<typeof currentResult>(null);
  if (fresh && fresh !== lastResult.current) {
    lastResult.current = fresh;
    runSeq.current += 1;
  }
  const abKey = fresh ? `${viewStem}#run${runSeq.current}` : `${viewStem}#view`;

  // A/B sources: fresh run → j.input / j.clean (app.js:1642); re-view →
  // the on-disk output WAVs (app.js:1717).
  const inputUrl = fresh ? fresh.input : viewStem ? `/output/${viewStem}/input_mono.wav` : null;
  const cleanUrl = fresh ? fresh.clean : viewStem ? `/output/${viewStem}/clean_prod.wav` : null;
  // Clean sublabel frozen per result (legacy computed it at render time of
  // the run, app.js:1644) — knob changes after the run must not rewrite it.
  const cleanSub = useMemo(
    () => (fresh ? `${opthLabel(getProdOpts())} / ${fresh.elapsed_s}s` : 'clean_prod.wav'),
    [fresh],
  );

  return (
    <div className="studio">
      <FileRail stem={viewStem} />

      <section className="studio-detail" aria-label="Studio detail">
        {viewStem && inputUrl && cleanUrl ? (
          <>
            <div className="studio-caption">
              <span className="studio-caption-tag">NOW VIEWING</span>
              <span className="studio-caption-file">{viewStem}.wav</span>
            </div>
            <ResultsHeader stem={viewStem} result={fresh} />
            <PipelineTimeline stem={viewStem} />
            <ABCompare
              key={abKey}
              inputUrl={inputUrl}
              cleanUrl={cleanUrl}
              inputSub="raw 8-ch downmix"
              cleanSub={cleanSub}
            />
            {fresh && <StageRack stages={fresh.stages} timings={fresh.timings} />}
            <PlayoutBar stem={viewStem} />
          </>
        ) : (
          <div className="card studio-empty">
            <div className="studio-empty-glyph">STU</div>
            <h2 className="studio-empty-title">Nothing to compare yet</h2>
            <p className="studio-empty-body">
              Clean a recording and its raw-vs-clean comparison, signal chain, and timings show up
              here.
            </p>
            <div className="studio-empty-actions">
              <button className="btn btn-primary" onClick={goLibrary}>
                Go to Library
              </button>
              <button
                className="btn"
                onClick={() => {
                  // Legacy studioEmptySample (shell.js:250-255): capture +
                  // Sample tab. The auto-clicked Generate is dropped — the
                  // user confirms SNR/duration first (PORTING.md §5.1 note).
                  openCapture();
                  selectCaptureTab('sample');
                }}
              >
                Try a sample
              </button>
            </div>
          </div>
        )}
      </section>

      <SettingsPanel stem={viewStem} />
    </div>
  );
}
