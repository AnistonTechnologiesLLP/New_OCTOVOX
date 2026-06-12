/* Sticky progress pill — the slim fixed mirror of a running clean (legacy
   sticky mini-bar: app.js:631-698, index.html:378-383), shown only when the
   user is NOT looking at the running file's Studio view (there the inline
   PipelineTimeline owns the job). Clicking navigates to that Studio — the
   modern equivalent of the legacy scroll-to-progress-panel.

   Exported for App.tsx to mount once at the shell level. */

import { goStudio, useHashRoute } from '../../hooks/useHashRoute';
import { STREAM_STAGES } from '../../lib/constants';
import { useSession } from '../../state/session';
import './studio.css';

const stemOf = (name: string): string => name.replace(/\.wav$/i, '');

export default function StickyProgress() {
  const progress = useSession((s) => s.progress);
  const selectedFile = useSession((s) => s.selectedFile);
  const currentStem = useSession((s) => s.currentStem);
  const { route } = useHashRoute();

  if (!progress.active) return null;
  const runningStem = selectedFile ? stemOf(selectedFile) : null;
  // Same fallback as StudioView: plain #/studio shows the current stem.
  const viewedStem = route.view === 'studio' ? (route.stem ?? currentStem) : null;
  if (runningStem != null && viewedStem === runningStem) return null;

  const pct = Math.max(0, Math.min(100, progress.pct));
  const stageLabel = STREAM_STAGES.find((s) => s.id === progress.stage)?.label ?? 'starting...';

  return (
    <button
      type="button"
      className="sticky-progress"
      role="status"
      aria-live="polite"
      title="Open the running file's Studio"
      onClick={() => {
        if (runningStem) goStudio(runningStem);
      }}
    >
      <span className="sp-text">
        <span className="sp-title">{progress.title || 'Working...'}</span>
        <span className="sp-sub">{stageLabel}</span>
      </span>
      <span className="sp-pct">{Math.round(pct)}%</span>
      <span className="sp-bar" aria-hidden="true">
        <span className="sp-fill" style={{ width: `${pct}%` }} />
      </span>
    </button>
  );
}
