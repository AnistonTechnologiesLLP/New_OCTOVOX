/* One Library row — status accent + dot, mono filename with inline rename,
   metadata line, winner pill, and Run/View / Rename / Del actions (legacy
   renderFilesList row, app.js:798-885). The buttons carry the legacy
   data-action attributes so the keyboard handler can .click() them
   (app.js:2234-2245). */

import { useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../../lib/types';
import type { WinnerInfo } from './winners';

/** Only this winner gets the gold accent (legacy app.js:802-806). */
const GOLD_WINNER = 'Neural-MVDR-WPE';

function fmtSize(kb: number): string {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
}

interface FileRowProps {
  file: FileEntry;
  idx: number;
  winner: WinnerInfo | undefined;
  focused: boolean;
  flashing: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
  onPrimary: (file: FileEntry) => Promise<void>;
  onRename: (file: FileEntry, newName: string) => Promise<boolean>;
  onDelete: (file: FileEntry) => void;
}

export default function FileRow({
  file,
  idx,
  winner,
  focused,
  flashing,
  rowRef,
  onPrimary,
  onRename,
  onDelete,
}: FileRowProps) {
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(file.name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);

  /* status drives the accent bar + dot: fresh (no result), gold (only the
     Neural-MVDR-WPE winner), else analysed — app.js:802-806 */
  const statusCls = winner
    ? winner.winner === GOLD_WINNER
      ? 'status-gold'
      : 'status-analysed'
    : 'status-fresh';

  /* Focus the rename input and pre-select the basename up to the last dot,
     extension excluded (legacy app.js:850-858). */
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = file.name.lastIndexOf('.');
    el.setSelectionRange(0, dot >= 0 ? dot : file.name.length);
  }, [editing, file.name]);

  const startEdit = (): void => {
    if (editing) return;
    setDraft(file.name);
    doneRef.current = false;
    setEditing(true);
  };

  /* Commit on Enter/blur, revert on Escape; no-op when unchanged or empty
     (legacy app.js:860-885). doneRef guards the Enter→blur double-fire. */
  const finishEdit = (commit: boolean): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    const next = draft.trim();
    if (!commit || !next || next === file.name) return;
    void onRename(file, next);
  };

  const meta: string[] = [`${file.duration.toFixed(1)} s`, fmtSize(file.size_kb)];
  if (file.samplerate > 0) meta.push(`${(file.samplerate / 1000).toFixed(0)} kHz`);
  if (file.channels > 0) meta.push(`${file.channels} ch`);

  const cls = [
    'file-row',
    statusCls,
    focused ? 'file-row-focused' : '',
    flashing ? 'flash-highlight' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      role="listitem"
      data-name={file.name}
      data-idx={idx}
      tabIndex={-1}
      ref={rowRef}
    >
      <div className="file-num" aria-hidden="true">
        {idx + 1}
      </div>
      <div className="file-icon" aria-hidden="true">
        WAV
      </div>
      <div className="file-main">
        {editing ? (
          <input
            ref={inputRef}
            className="file-rename-input"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            aria-label="New file name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => finishEdit(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                finishEdit(true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                finishEdit(false);
              }
            }}
          />
        ) : (
          <div className="file-name">{file.name}</div>
        )}
        <div className="file-meta">
          <span className="file-dot" aria-hidden="true" />
          <span>{meta.join(' / ')}</span>
        </div>
      </div>
      {winner ? (
        <div
          className="file-pill"
          title={`Bootstrap winner: ${winner.winner} (${winner.confidence.toFixed(0)}%)`}
        >
          {winner.winner}
        </div>
      ) : (
        <div className="file-pill file-pill-empty">not analysed</div>
      )}
      <div className="file-actions">
        <button
          type="button"
          className={`file-btn file-btn-go${winner ? '' : ' primary'}`}
          data-action="analyse"
          data-state={running ? 'running' : undefined}
          title={winner ? 'View results' : 'Analyse'}
          onClick={(e) => {
            e.stopPropagation();
            if (running) return;
            setRunning(true);
            void onPrimary(file).finally(() => setRunning(false));
          }}
        >
          {running ? '...' : winner ? 'View' : 'Run'}
        </button>
        <button
          type="button"
          className="file-btn"
          data-action="rename"
          title="Rename"
          onClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
        >
          Rename
        </button>
        <button
          type="button"
          className="file-btn file-btn-del"
          data-action="delete"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(file);
          }}
        >
          Del
        </button>
      </div>
    </div>
  );
}
