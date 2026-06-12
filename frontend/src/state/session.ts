/* Cross-view session state: busy lock (single-operation rule + 5-min
   watchdog, app.js:45-82), live streaming progress, the current clean
   result, and speaker-targeting state (app.js:23-34). */

import { create } from 'zustand';
import type { CleanResult, Speaker } from '../lib/types';
import { toast } from './toasts';

export interface ProgressState {
  active: boolean;
  title: string;
  message: string;
  pct: number;
  stage: string | null;
  /** Stage ids that have been passed (drive the timeline check marks). */
  reached: string[];
  log: string[];
}

const idleProgress: ProgressState = {
  active: false,
  title: '',
  message: '',
  pct: 0,
  stage: null,
  reached: [],
  log: [],
};

interface SessionStore {
  /* busy lock */
  busy: boolean;
  busyWhat: string | null;
  acquire: (what: string) => boolean;
  release: () => void;

  /* streaming progress */
  progress: ProgressState;
  showProgress: (title: string) => void;
  updateProgress: (message: string, pct: number, stage?: string) => void;
  completeProgress: () => void;
  hideProgress: () => void;

  /* current result */
  currentStem: string | null;
  currentResult: CleanResult | null;
  setResult: (r: CleanResult) => void;
  setStem: (stem: string | null) => void;
  clearResult: () => void;

  /* speaker targeting */
  selectedFile: string | null;
  setSelectedFile: (f: string | null) => void;
  detectedSpeakers: Speaker[];
  speakersFile: string | null;
  targetAz: number | null;
  interfererAz: number[];
  setSpeakers: (speakers: Speaker[], file: string | null) => void;
  setTarget: (targetAz: number | null, interfererAz?: number[]) => void;
  /** A speaker azimuth detected on a different recording must not bleed into
   *  a run on this file (app.js resetSpeakersForFile semantics). */
  resetSpeakersForFile: (filename: string) => void;

  /* batch run flag (suppresses auto-detect during "Clean all") */
  runningAll: boolean;
  setRunningAll: (v: boolean) => void;
}

let watchdog: ReturnType<typeof setTimeout> | null = null;

export const useSession = create<SessionStore>((set, get) => ({
  busy: false,
  busyWhat: null,
  acquire: (what) => {
    const s = get();
    if (s.busy) {
      toast(`Wait - ${s.busyWhat} is still running. Try again when it finishes.`, 'warn');
      return false;
    }
    set({ busy: true, busyWhat: what });
    document.body.classList.add('octovox-busy');
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (get().busy) {
        console.warn('[Busy] watchdog auto-release after 5 min:', get().busyWhat);
        toast(
          `Operation "${get().busyWhat}" took too long - UI unlocked. Check the server terminal for errors.`,
          'warn',
        );
        get().release();
        get().hideProgress();
      }
    }, 5 * 60 * 1000);
    return true;
  },
  release: () => {
    set({ busy: false, busyWhat: null });
    document.body.classList.remove('octovox-busy');
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  },

  progress: idleProgress,
  showProgress: (title) => set({ progress: { ...idleProgress, active: true, title } }),
  updateProgress: (message, pct, stage) =>
    set((s) => {
      const p = s.progress;
      const reached = stage && !p.reached.includes(stage) ? [...p.reached, stage] : p.reached;
      const log = message && message !== p.log[p.log.length - 1] ? [...p.log, message].slice(-200) : p.log;
      return {
        progress: {
          ...p,
          active: true,
          message: message || p.message,
          pct: Number.isFinite(pct) ? pct : p.pct,
          stage: stage ?? p.stage,
          reached,
          log,
        },
      };
    }),
  completeProgress: () =>
    set((s) => ({ progress: { ...s.progress, pct: 100 } })),
  hideProgress: () => set({ progress: idleProgress }),

  currentStem: null,
  currentResult: null,
  setResult: (r) => set({ currentResult: r, currentStem: r.stem }),
  setStem: (stem) => set({ currentStem: stem }),
  clearResult: () => set({ currentResult: null, currentStem: null }),

  selectedFile: null,
  setSelectedFile: (f) => set({ selectedFile: f }),
  detectedSpeakers: [],
  speakersFile: null,
  targetAz: null,
  interfererAz: [],
  setSpeakers: (speakers, file) => set({ detectedSpeakers: speakers, speakersFile: file }),
  setTarget: (targetAz, interfererAz = []) => set({ targetAz, interfererAz }),
  resetSpeakersForFile: (filename) => {
    // Exact legacy parity (app.js:1230-1237): keep the picker ONLY when the
    // list already belongs to this file — a manual aim made before any Detect
    // (speakersFile null) is intentionally wiped on every run.
    if (get().speakersFile === filename) return;
    set({ detectedSpeakers: [], speakersFile: null, targetAz: null, interfererAz: [] });
  },

  runningAll: false,
  setRunningAll: (v) => set({ runningAll: v }),
}));

/** Global error trap (app.js:90-102): surface uncaught errors as toasts and
 *  force-release the busy lock so the UI never sticks. Call once at boot. */
export function installGlobalErrorTrap(): void {
  window.addEventListener('error', (e) => {
    console.error('[OCTOVOX] uncaught error:', e.error || e.message);
    toast(`Unexpected error: ${e.message || 'unknown'}. UI reset.`, 'error');
    useSession.getState().release();
    useSession.getState().hideProgress();
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[OCTOVOX] unhandled rejection:', e.reason);
    const r = e.reason as { message?: string } | undefined;
    const msg = (r && r.message) || String(e.reason || 'unknown');
    toast(`Background task failed: ${msg}. UI reset.`, 'error');
    useSession.getState().release();
    useSession.getState().hideProgress();
  });
}
