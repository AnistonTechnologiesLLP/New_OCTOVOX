/* Theme manager — ports shell.js Theme (lines 25-52): pref persisted to
   'octovox-theme' (shared with /acoustics), 'system' follows the OS via
   matchMedia, cross-tab sync via the storage event, and toggle() is the
   legacy 2-way flip of the RESOLVED mode (it intentionally abandons
   'system', same as the old console). */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

const KEY = 'octovox-theme';

export type ThemePref = 'light' | 'dark' | 'system';
export type ThemeMode = 'light' | 'dark';

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function systemDark(): boolean {
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolvedMode(): ThemeMode {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

const listeners = new Set<() => void>();
function notify(): void { listeners.forEach((l) => l()); }

export function applyTheme(pref: ThemePref): void {
  const mode: ThemeMode = pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref;
  document.documentElement.setAttribute('data-theme', mode);
  notify();
}

export function setThemePref(pref: ThemePref): void {
  try { localStorage.setItem(KEY, pref); } catch { /* private mode — theme just won't persist */ }
  applyTheme(pref);
}

/** Legacy 2-way flip of the resolved mode (shell.js:37). */
export function toggleTheme(): void {
  setThemePref(resolvedMode() === 'light' ? 'dark' : 'light');
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive resolved theme mode; also wires the global listeners once. */
export function useTheme(): { mode: ThemeMode; toggle: () => void } {
  const mode = useSyncExternalStore(subscribe, resolvedMode);
  useEffect(() => {
    applyTheme(themePref());
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onSystem = (): void => {
      if (themePref() === 'system') applyTheme('system');
    };
    const onStorage = (e: StorageEvent): void => {
      if (e.key === KEY) applyTheme((e.newValue as ThemePref) || 'system');
    };
    mq.addEventListener('change', onSystem);
    window.addEventListener('storage', onStorage);
    return () => {
      mq.removeEventListener('change', onSystem);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const toggle = useCallback(() => toggleTheme(), []);
  return { mode, toggle };
}

/** Read themed canvas/WaveSurfer colors from CSS custom properties; re-read
 *  whenever the theme changes (ports refreshThemedJsColors semantics). */
export function readCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
