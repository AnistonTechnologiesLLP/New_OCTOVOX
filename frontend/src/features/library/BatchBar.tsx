/* Library batch actions — Clean all (legacy "Run all", app.js:975-1029),
   Clear output (app.js:1037-1088) and Refresh. Also registers the palette
   commands for these three (legacy shell.js:119-121 clicked the toolbar
   buttons by id); they are offered only while this bar is mounted — an
   accepted IA deviation noted in PORTING.md §5.3. */

import { useShellCommand } from '../../components/shell/commands';

interface BatchBarProps {
  /** Local per-batch progress (null when idle). */
  batch: { i: number; n: number } | null;
  /** Session-level flag — survives this view unmounting mid-batch. */
  runningAll: boolean;
  onCleanAll: () => void;
  onClearOutput: () => void;
  onRefresh: () => void;
}

export default function BatchBar({
  batch,
  runningAll,
  onCleanAll,
  onClearOutput,
  onRefresh,
}: BatchBarProps) {
  useShellCommand({ id: 'clean-all', label: 'Clean all files', hint: 'Library', run: onCleanAll });
  useShellCommand({ id: 'clear-output', label: 'Clear all output', hint: 'Library', run: onClearOutput });
  useShellCommand({ id: 'refresh', label: 'Refresh file list', hint: 'Library', run: onRefresh });

  const cleanLabel = batch ? `Running ${batch.i}/${batch.n}...` : runningAll ? 'Running...' : 'Clean all';
  return (
    <div className="lib-actions cluster">
      <button
        type="button"
        className="btn btn-primary"
        disabled={batch != null || runningAll}
        title="Clean every file that has no result yet"
        onClick={onCleanAll}
      >
        {cleanLabel}
      </button>
      <button
        type="button"
        className="btn"
        title="Remove all results - input files are kept"
        onClick={onClearOutput}
      >
        Clear output
      </button>
      <button type="button" className="btn btn-ghost" title="Refresh the file list (R)" onClick={onRefresh}>
        Refresh
      </button>
    </div>
  );
}
