/* Command palette — ports the legacy Cmdk (shell.js:108-234): Ctrl/Cmd+K
   toggle and palette-open keys (Esc / arrows / Enter) on a CAPTURE-phase
   window listener with preventDefault+stopPropagation, subsequence fuzzy
   scoring (fuzzyScore.ts, verbatim), top-9 results with the first item
   pre-selected, mousemove-select + click-run, backdrop click to close, and
   the input focused ~20 ms after open with a cleared query.

   Coordination with the other key owners (no propagation-order gambling):
   - While open the input keeps focus (panel mousedown is prevented), so the
     Library's capture-phase handler bails on its isTypingInField() guard and
     App's bubble handler additionally checks usePalette.open.
   - stopPropagation on the palette keys stops the event at the window
     CAPTURE phase, so App's bubble-phase Esc cascade never fires for the
     palette's own Esc.

   Action sources (PORTING.md §5.3 DECISION notes):
   - static: New recording / Upload a WAV / Generate sample (capture drawer +
     tab; legacy's extra focus/auto-browse click is dropped — noted),
     Go to Library, Open Acoustics, Toggle theme, View error log,
     Keyboard shortcuts.
   - registry: clean-all / clear-output / refresh / generate-sample appear
     only while their owning component is mounted (accepted IA deviation).
   - conditional on session.currentStem: Go to Studio + Re-run clean +
     Download clean WAV + Open report + Detect speakers run the real logic
     from here (it lives in shared stores/api); Play to device is
     navigation-only because the output-device choice is local to PlayoutBar.
   - dynamic: "Open <file>" per file from the shared ['files'] query. */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useCommands } from './commands';
import { useErrlogUI } from './ErrorLogModal';
import { fuzzyScore } from './fuzzyScore';
import { showShortcutsHelp } from './ShortcutsHelp';
import { selectCaptureTab } from '../../features/capture/CaptureDrawer';
import { flashFile } from '../../features/library/flash';
import { useCleanRun } from '../../hooks/useCleanStream';
import { goLibrary, goStudio, openCapture } from '../../hooks/useHashRoute';
import { toggleTheme } from '../../hooks/useTheme';
import { api } from '../../lib/api';
import { useSession } from '../../state/session';
import { toast } from '../../state/toasts';

interface PaletteUI {
  open: boolean;
  show: () => void;
  close: () => void;
  toggle: () => void;
}

export const usePalette = create<PaletteUI>((set, get) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
  toggle: () => set({ open: !get().open }),
}));

interface PaletteAction {
  label: string;
  hint: string;
  run: () => void;
}

/** Download the clean WAV — fresh result's URL when it matches, else the
 *  on-disk output path (same resolution as ResultsHeader). */
function downloadClean(stem: string): void {
  const r = useSession.getState().currentResult;
  const url = r && r.stem === stem ? r.clean : `/output/${stem}/clean_prod.wav`;
  window.location.href = url;
}

/** Open the report: fresh runs gate on j.report (app.js:1624-1627); re-view
 *  probes with HEAD like ResultsHeader (PORTING.md §4.2 DECISION). The tab is
 *  opened synchronously inside the click gesture so popup blockers stay calm,
 *  then pointed at the report (or closed + warned). */
function openReport(stem: string): void {
  const r = useSession.getState().currentResult;
  if (r && r.stem === stem) {
    if (r.report) window.open(r.report, '_blank', 'noopener');
    else toast('No report for this run.', 'warn');
    return;
  }
  const url = `/output/${stem}/report.html`;
  const win = window.open('', '_blank'); // same-origin report; no opener risk
  fetch(url, { method: 'HEAD' })
    .then((res) => {
      if (res.ok && win) {
        win.location.href = url;
      } else {
        win?.close();
        toast('No report for this run.', 'warn');
      }
    })
    .catch(() => {
      win?.close();
      toast('No report for this run.', 'warn');
    });
}

/** Detect talker directions — same flow as SpeakerCard.detect (app.js:1105-
 *  1129, 1421-1425), runnable without the Studio mounted: selectedFile first,
 *  else the current stem; legacy toast copy. */
async function detectSpeakers(): Promise<void> {
  const s = useSession.getState();
  const fname = s.selectedFile || (s.currentStem ? `${s.currentStem}.wav` : null);
  if (!fname) {
    toast('Select or clean a file first, then detect speakers.', 'warn');
    return;
  }
  try {
    const j = await api.speakers(fname);
    const speakers = j.speakers || [];
    useSession.getState().setSpeakers(speakers, fname);
    const n = speakers.length;
    toast(
      n > 0
        ? `Found ${n} talker direction${n > 1 ? 's' : ''} - pick one below to extract it.`
        : 'No distinct speaker directions found (may be single-speaker or reverberant).',
      n > 0 ? 'ok' : 'warn',
    );
  } catch (err) {
    toast(`Speaker detect failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

export default function CommandPalette() {
  const open = usePalette((s) => s.open);
  const registry = useCommands((s) => s.commands);
  const stem = useSession((s) => s.currentStem);
  const runClean = useCleanRun();

  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemEls = useRef<(HTMLLIElement | null)[]>([]);

  // Dynamic "Open <file>" actions share the Library's query cache; only
  // fetched while the palette is open.
  const filesQ = useQuery({ queryKey: ['files'], queryFn: () => api.listInput(), enabled: open });

  /* ---- action list (legacy buildActions order, shell.js:112-150) ---------- */
  const actions = useMemo<PaletteAction[]>(() => {
    const A: PaletteAction[] = [
      { label: 'New recording', hint: 'Capture', run: () => { openCapture(); selectCaptureTab('record'); } },
      { label: 'Upload a WAV', hint: 'Capture', run: () => { openCapture(); selectCaptureTab('upload'); } },
      { label: 'Generate sample', hint: 'Capture', run: () => { openCapture(); selectCaptureTab('sample'); } },
      { label: 'Go to Library', hint: 'Files', run: () => goLibrary() },
    ];
    for (const c of registry) {
      if (c.when && !c.when()) continue;
      A.push({ label: c.label, hint: c.hint ?? '', run: c.run });
    }
    if (stem) {
      A.push(
        { label: 'Go to Studio', hint: 'Console', run: () => goStudio(stem) },
        { label: 'Re-run clean', hint: 'Studio', run: () => { void runClean(`${stem}.wav`); } },
        { label: 'Download clean WAV', hint: 'Studio', run: () => downloadClean(stem) },
        { label: 'Open report', hint: 'Studio', run: () => openReport(stem) },
        // Navigation-only: the output-device picker is PlayoutBar-local state.
        { label: 'Play to device', hint: 'Studio', run: () => goStudio(stem) },
        { label: 'Detect speakers', hint: 'Studio', run: () => { void detectSpeakers(); } },
      );
    }
    A.push(
      { label: 'Open Acoustics', hint: 'Tools', run: () => { window.location.href = '/acoustics'; } },
      { label: 'Toggle theme', hint: 'View', run: () => toggleTheme() },
      { label: 'View error log', hint: 'Diagnostics', run: () => useErrlogUI.getState().show() },
      { label: 'Keyboard shortcuts', hint: 'Help', run: () => showShortcutsHelp() },
    );
    for (const f of filesQ.data?.files ?? []) {
      A.push({
        label: `Open ${f.name}`,
        hint: 'File',
        run: () => {
          goLibrary();
          flashFile(f.name);
        },
      });
    }
    return A;
  }, [registry, stem, filesQ.data, runClean]);

  /* ---- score / sort / top 9 (shell.js:164-169) ---------------------------- */
  const filtered = useMemo(() => {
    const q = query.trim();
    return actions
      .map((a) => ({ a, s: fuzzyScore(a.label, q) }))
      .filter((x) => x.s >= 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 9)
      .map((x) => x.a);
  }, [actions, query]);

  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const selRef = useRef(sel);
  selRef.current = sel;

  // First result pre-selected on every query change / open.
  useEffect(() => {
    setSel(0);
  }, [query, open]);

  // Cleared query + focus ~20 ms after open (shell.js:197-202).
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  /* ---- capture-phase keydown (shell.js:221-230) --------------------------- */
  useEffect(() => {
    const moveSel = (d: number): void => {
      const n = filteredRef.current.length;
      if (!n) return;
      const next = (((selRef.current + d) % n) + n) % n;
      setSel(next);
      itemEls.current[next]?.scrollIntoView({ block: 'nearest' });
    };
    const runSelected = (): void => {
      const a = filteredRef.current[selRef.current];
      if (!a) return;
      usePalette.getState().close();
      try {
        a.run();
      } catch (err) {
        console.error(err);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key;
      if ((e.metaKey || e.ctrlKey) && (k === 'k' || k === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        usePalette.getState().toggle();
        return;
      }
      if (!usePalette.getState().open) return;
      if (k === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        usePalette.getState().close();
      } else if (k === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        moveSel(1);
      } else if (k === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        moveSel(-1);
      } else if (k === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        runSelected();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!open) return null;

  const runAt = (i: number): void => {
    const a = filteredRef.current[i];
    if (!a) return;
    usePalette.getState().close();
    try {
      a.run();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="cmdk-root" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="cmdk-backdrop" onClick={() => usePalette.getState().close()} />
      <div
        className="cmdk-panel"
        onMouseDown={(e) => {
          // Keep focus in the input so the typing-field guards hold while the
          // palette is open (clicks on items still fire).
          if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
        }}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          type="text"
          placeholder="Type a command..."
          autoComplete="off"
          spellCheck={false}
          aria-label="Search commands"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="cmdk-list" role="listbox" aria-label="Commands">
          {filtered.length === 0 ? (
            <li className="cmdk-empty">No matching commands</li>
          ) : (
            filtered.map((a, i) => (
              <li
                key={a.label}
                className={`cmdk-item${i === sel ? ' sel' : ''}`}
                role="option"
                aria-selected={i === sel}
                ref={(el) => {
                  itemEls.current[i] = el;
                }}
                onMouseMove={() => setSel(i)}
                onClick={() => runAt(i)}
              >
                <span className="cmdk-item-lab">{a.label}</span>
                <span className="cmdk-item-hint">{a.hint}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
