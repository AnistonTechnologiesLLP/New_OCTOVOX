/* Library home — table-style card of input recordings with filter/sort,
   Run/View / Rename / Delete row actions, batch operations and full keyboard
   navigation. Ports the legacy files panel (app.js:640-1100) and the file-row
   shortcuts (app.js:2108-2246) onto TanStack Query + the shared session/toast/
   modal stores. */

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BatchBar from './BatchBar';
import FileRow from './FileRow';
import FilesToolbar, { isSortMode, type SortMode } from './FilesToolbar';
import { useFlashStore } from './flash';
import { buildWinnerMap, stemOf, type WinnerInfo } from './winners';
import './library.css';
import { useErrlogUI } from '../../components/shell/ErrorLogModal';
import { useCleanRun } from '../../hooks/useCleanStream';
import { goLibrary, goStudio, openCapture, parseHash } from '../../hooks/useHashRoute';
import { api } from '../../lib/api';
import type { FileEntry } from '../../lib/types';
import { showModal, useModal } from '../../state/modals';
import { useSession } from '../../state/session';
import { toast, useToasts } from '../../state/toasts';

const SORT_KEY = 'octovox.fileSort';

function isTypingInField(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
  );
}

/** Undo a soft-delete — restore the trashed file and refresh (app.js:614-629). */
async function restoreDeleted(qc: QueryClient, token: string, fname: string): Promise<void> {
  try {
    const j = await api.restoreFile(token);
    toast(`Restored ${j.restored || fname}`);
    void qc.invalidateQueries({ queryKey: ['files'] });
    void qc.invalidateQueries({ queryKey: ['verdict'] });
  } catch (err) {
    toast(`Couldn't restore: ${err instanceof Error ? err.message : 'unknown error'}`, 'error');
  }
}

export default function LibraryView() {
  const queryClient = useQueryClient();
  const runClean = useCleanRun();
  const runningAll = useSession((s) => s.runningAll);

  /* ---- data: files + verdict winner map, fetched in parallel ------------- */
  const filesQ = useQuery({ queryKey: ['files'], queryFn: () => api.listInput() });
  const verdictQ = useQuery({ queryKey: ['verdict'], queryFn: () => api.verdict() });

  const files = useMemo(() => filesQ.data?.files ?? [], [filesQ.data]);
  const wMap = useMemo(() => buildWinnerMap(verdictQ.data), [verdictQ.data]);
  const wMapRef = useRef(wMap);
  wMapRef.current = wMap;

  /* ---- sort (persisted to octovox.fileSort) + filter (80 ms debounce,
          intentionally never persisted — app.js:707-737) ------------------- */
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    try {
      const v = localStorage.getItem(SORT_KEY) || 'newest';
      return isSortMode(v) ? v : 'newest';
    } catch {
      return 'newest'; // localStorage may be blocked in private mode
    }
  });
  const [filterText, setFilterText] = useState('');
  const [filterQ, setFilterQ] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setFilterQ(filterText), 80);
    return () => clearTimeout(t);
  }, [filterText]);

  const changeSort = useCallback((v: SortMode) => {
    setSortMode(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      /* private mode */
    }
  }, []);

  const clearFilter = useCallback(() => {
    setFilterText('');
    setFilterQ('');
    filterRef.current?.focus();
  }, []);

  /* Sort/filter re-render uses cached query data — no network round-trip
     (legacy rerenderFiles, app.js:749-753). Sort logic per app.js:944-965. */
  const visible = useMemo(() => {
    const q = filterQ.trim().toLowerCase();
    let arr = files.slice();
    if (q) arr = arr.filter((f) => f.name.toLowerCase().includes(q));
    if (sortMode === 'newest') arr.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    else if (sortMode === 'oldest') arr.sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0));
    else if (sortMode === 'name') arr.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortMode === 'winrate') {
      // "Recently cleaned": confidence desc, -1 for unanalysed (app.js:955-962)
      arr.sort((a, b) => {
        const cA = wMap[stemOf(a.name)]?.confidence || -1;
        const cB = wMap[stemOf(b.name)]?.confidence || -1;
        return cB - cA;
      });
    }
    return arr;
  }, [files, wMap, filterQ, sortMode]);

  const visibleRef = useRef<FileEntry[]>(visible);
  visibleRef.current = visible;

  /* ---- row focus ring (keyboard nav) -------------------------------------- */
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    rowEls.current.length = visible.length;
  }, [visible]);

  const focusRow = useCallback((idx: number) => {
    const n = visibleRef.current.length;
    if (!n) return;
    const i = ((idx % n) + n) % n; // wrap around (app.js:2138-2147)
    setFocusIdx(i);
    const el = rowEls.current[i];
    if (el) {
      el.focus({ preventScroll: false });
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, []);

  /* ---- shared refresh ----------------------------------------------------- */
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['files'] });
    void queryClient.invalidateQueries({ queryKey: ['verdict'] });
  }, [queryClient]);

  /* ---- row actions ---------------------------------------------------------- */

  /* Run (no result yet) or View (results exist) — app.js:829-843. */
  const onPrimary = useCallback(
    async (file: FileEntry): Promise<void> => {
      const stem = stemOf(file.name);
      const session = useSession.getState();
      session.setSelectedFile(file.name);
      if (wMapRef.current[stem]) {
        session.setStem(stem);
        goStudio(stem);
        return;
      }
      await runClean(file.name);
    },
    [runClean],
  );

  /* Inline rename commit — extension is preserved client-side by only
     pre-selecting the basename; the server appends .wav when missing
     (api.py:373-374). */
  const onRename = useCallback(
    async (file: FileEntry, newName: string): Promise<boolean> => {
      try {
        const j = await api.renameFile(file.name, newName);
        toast(`Renamed to ${j.new}`);
        void queryClient.invalidateQueries({ queryKey: ['files'] });
        void queryClient.invalidateQueries({ queryKey: ['verdict'] });
        return true;
      } catch (err) {
        toast(`Rename failed: ${err instanceof Error ? err.message : '?'}`, 'error');
        return false;
      }
    },
    [queryClient],
  );

  /* Delete with confirm modal + Undo action toast (app.js:887-939). */
  const onDelete = useCallback(
    async (file: FileEntry): Promise<void> => {
      const choice = await showModal({
        icon: 'DEL',
        iconType: 'error',
        title: 'Delete this recording?',
        body: (
          <>
            <p>
              You're about to permanently delete <code>{file.name}</code>.
            </p>
            <div className="modal-info">
              <div className="mi-row">
                <span>The .wav file</span>
                <b style={{ color: 'var(--rose)' }}>will be removed</b>
              </div>
              <div className="mi-row">
                <span>Its analysis results</span>
                <b style={{ color: 'var(--rose)' }}>will be removed</b>
              </div>
              <div className="mi-row">
                <span>Best-algorithm verdict</span>
                <b>will refresh</b>
              </div>
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>This can't be undone.</p>
          </>
        ),
        buttons: [
          { id: 'cancel', label: 'Keep it', variant: 'ghost' },
          { id: 'delete', label: 'Delete', variant: 'danger' },
        ],
      });
      if (choice !== 'delete') return;
      try {
        const j = await api.deleteFile(file.name);
        const stem = stemOf(file.name);
        const session = useSession.getState();
        if (session.currentStem === stem) {
          // Deleting the open Studio file resets it and bounces Studio→Library
          // (app.js:913-923; player teardown is reactive once Studio lands).
          session.setStem(null);
          if (parseHash(location.hash).view === 'studio') goLibrary();
        }
        refresh();
        if (j.restore_token) {
          // The file is in the trash, not gone — offer an Undo (app.js:927-934).
          toast(`Deleted ${file.name}`, 'ok', {
            duration: 8000,
            action: {
              label: 'Undo',
              onClick: () => {
                void restoreDeleted(queryClient, j.restore_token, file.name);
              },
            },
          });
        } else {
          toast(`Deleted ${file.name}`);
        }
      } catch (err) {
        toast(`Delete failed: ${err instanceof Error ? err.message : '?'}`, 'error');
      }
    },
    [queryClient, refresh],
  );

  /* ---- batch: Clean all (legacy Run all, app.js:975-1029) ------------------- */
  const [batch, setBatch] = useState<{ i: number; n: number } | null>(null);

  const cleanAll = useCallback(async (): Promise<void> => {
    const session = useSession.getState();
    if (session.runningAll) return;
    if (session.busy) {
      toast(`Wait - ${session.busyWhat} is still running. Try Clean all when it finishes.`, 'warn');
      return;
    }

    // Operate on a fresh list + which files already have results.
    let all: FileEntry[];
    let wm: Record<string, WinnerInfo>;
    try {
      const [filesJ, vJ] = await Promise.all([
        queryClient.fetchQuery({ queryKey: ['files'], queryFn: () => api.listInput(), staleTime: 0 }),
        queryClient.fetchQuery({ queryKey: ['verdict'], queryFn: () => api.verdict(), staleTime: 0 }),
      ]);
      all = filesJ.files || [];
      wm = buildWinnerMap(vJ);
    } catch {
      toast('Could not refresh the file list - check the server.', 'error');
      return;
    }
    if (!all.length) {
      toast('No files to analyse - record, upload, or generate a sample first.', 'warn');
      return;
    }
    const pending = all.filter((f) => !wm[stemOf(f.name)]);
    if (!pending.length) {
      toast('All files are already analysed - use Clear output first to re-run them.');
      return;
    }

    // Target-speaker extraction is a single-file, interactive choice; drop it
    // up front so batch results are order-independent (app.js:996-1003).
    session.setSpeakers([], null);
    session.setTarget(null, []);

    session.setRunningAll(true);
    let ok = 0;
    let fail = 0;
    try {
      for (let i = 0; i < pending.length; i++) {
        const f = pending[i];
        if (!f) continue;
        setBatch({ i: i + 1, n: pending.length });
        toast(`Analysing ${f.name} (${i + 1}/${pending.length})`);
        const success = await runClean(f.name);
        if (success) ok++;
        else fail++;
      }
      toast(
        fail
          ? `Clean all finished - ${ok} analysed, ${fail} failed. Check the server terminal.`
          : `Clean all finished - analysed ${ok} file${ok === 1 ? '' : 's'}`,
        fail ? 'warn' : undefined,
      );
    } finally {
      useSession.getState().setRunningAll(false);
      setBatch(null);
      refresh();
    }
  }, [queryClient, refresh, runClean]);

  /* ---- batch: Clear output (app.js:1037-1088) -------------------------------- */
  const clearOutput = useCallback(async (): Promise<void> => {
    const session = useSession.getState();
    if (session.runningAll) {
      toast('Wait - Clean all is still in progress.', 'warn');
      return;
    }
    if (session.busy) {
      toast(`Wait - ${session.busyWhat} is still running.`, 'warn');
      return;
    }
    const choice = await showModal({
      icon: 'DEL',
      iconType: 'error',
      title: 'Clear all previous output?',
      body: (
        <>
          <p>
            This permanently removes <b>every analysis result</b> - winner audio, visualizations,
            reports and metrics for all recordings.
          </p>
          <div className="modal-info">
            <div className="mi-row">
              <span>Your input .wav files</span>
              <b>will be kept</b>
            </div>
            <div className="mi-row">
              <span>All analysis results</span>
              <b style={{ color: 'var(--rose)' }}>will be removed</b>
            </div>
            <div className="mi-row">
              <span>Best-algorithm verdict</span>
              <b>will reset</b>
            </div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>
            You can re-analyse any file afterwards. This can't be undone.
          </p>
        </>
      ),
      buttons: [
        { id: 'cancel', label: 'Keep results', variant: 'ghost' },
        { id: 'clear', label: 'Clear output', variant: 'danger' },
      ],
    });
    if (choice !== 'clear') return;
    try {
      const j = await api.clearOutput();
      // Reset any currently-open results view (app.js:1072-1080).
      useSession.getState().setStem(null);
      if (parseHash(location.hash).view === 'studio') goLibrary();
      toast(`Cleared ${j.removed} result${j.removed === 1 ? '' : 's'}`);
      refresh();
    } catch (err) {
      toast(`Clear failed: ${err instanceof Error ? err.message : '?'}`, 'error');
    }
  }, [refresh]);

  /* ---- keyboard navigation (app.js:2108-2246) --------------------------------
     Capture phase so this runs before the shell's bubble-phase handler: the
     Esc branch only clears the row focus when the shell cascade (modal →
     error log → newest toast) has nothing left to do. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (useModal.getState().isOpen()) return;
        if (useErrlogUI.getState().open) return;
        if (useToasts.getState().toasts.length > 0) return;
        // Esc on a focused file row clears the focus (app.js:2181-2186).
        setFocusIdx(null);
        const active = document.activeElement as HTMLElement | null;
        if (active && rowEls.current.some((r) => r === active)) active.blur();
        return;
      }
      if (isTypingInField()) return;
      if (useModal.getState().isOpen()) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === '/') {
        e.preventDefault();
        const el = filterRef.current;
        if (el) {
          el.focus();
          el.select();
        }
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        refresh();
        toast('Files refreshed');
        return;
      }

      const n = visibleRef.current.length;
      if (!n) return;
      const active = document.activeElement;
      let cur = -1;
      for (let i = 0; i < n; i++) {
        if (rowEls.current[i] === active) {
          cur = i;
          break;
        }
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusRow(cur === -1 ? 0 : cur + 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusRow(cur === -1 ? n - 1 : cur - 1);
        return;
      }
      if (cur === -1) return; // remaining shortcuts only work on a focused row

      if (e.key === 'Enter') {
        e.preventDefault();
        rowEls.current[cur]?.querySelector<HTMLButtonElement>('[data-action="analyse"]')?.click();
        return;
      }
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        rowEls.current[cur]?.querySelector<HTMLButtonElement>('[data-action="delete"]')?.click();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focusRow, refresh]);

  /* ---- flash-highlight hand-off (flashFile(), legacy app.js:497-508) -------- */
  const pendingFlash = useFlashStore((s) => s.pending);
  const [flashName, setFlashName] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingFlash || !filesQ.data) return;
    const idx = visible.findIndex((f) => f.name === pendingFlash);
    if (idx === -1) {
      // Row not rendered: keep waiting while a refetch is in flight, otherwise
      // drop the request (file deleted/renamed or filtered out).
      if (!filesQ.isFetching) useFlashStore.getState().clear();
      return;
    }
    useFlashStore.getState().clear();
    setFlashName(pendingFlash);
    rowEls.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => {
      setFlashName((cu) => (cu === pendingFlash ? null : cu));
    }, 2400);
  }, [pendingFlash, visible, filesQ.data, filesQ.isFetching]);

  /* ---- render ------------------------------------------------------------------ */
  const countText =
    visible.length === files.length
      ? `${files.length} file${files.length === 1 ? '' : 's'}`
      : `${visible.length} of ${files.length}`;
  const focusActive = focusIdx != null && focusIdx < visible.length ? focusIdx : null;

  return (
    <section className="library stack">
      <div className="lib-head">
        <div>
          <h1>Library</h1>
          <p className="muted">Your recordings - clean, re-view, rename, or delete.</p>
        </div>
        {files.length > 0 && (
          <BatchBar
            batch={batch}
            runningAll={runningAll}
            onCleanAll={() => {
              void cleanAll();
            }}
            onClearOutput={() => {
              void clearOutput();
            }}
            onRefresh={refresh}
          />
        )}
      </div>

      {filesQ.isPending ? (
        <div className="card lib-state">
          <p className="muted">Loading files...</p>
        </div>
      ) : filesQ.isError ? (
        <div className="card lib-state">
          <p className="muted">Couldn't load the file list.</p>
          <button type="button" className="btn" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : files.length === 0 ? (
        <div className="card lib-empty">
          <div className="lib-empty-icon" aria-hidden="true">
            LIB
          </div>
          <h2>No files yet</h2>
          <p className="muted">
            Record, upload, or generate a sample in Capture. You can also drag &amp; drop a .wav
            file onto the upload panel.
          </p>
          <div className="cluster lib-empty-actions">
            <button type="button" className="btn btn-primary" onClick={openCapture}>
              New capture
            </button>
          </div>
        </div>
      ) : (
        <div className="card files-card">
          <FilesToolbar
            filter={filterText}
            onFilterChange={setFilterText}
            onClearFilter={clearFilter}
            sort={sortMode}
            onSortChange={changeSort}
            countText={countText}
            filterRef={filterRef}
          />
          {visible.length === 0 ? (
            <div className="files-no-match">No files match this filter.</div>
          ) : (
            <div className="files-list" role="list">
              {visible.map((f, idx) => (
                <FileRow
                  key={f.name}
                  file={f}
                  idx={idx}
                  winner={wMap[stemOf(f.name)]}
                  focused={focusActive === idx}
                  flashing={flashName === f.name}
                  rowRef={(el) => {
                    rowEls.current[idx] = el;
                  }}
                  onPrimary={onPrimary}
                  onRename={onRename}
                  onDelete={(file) => {
                    void onDelete(file);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
