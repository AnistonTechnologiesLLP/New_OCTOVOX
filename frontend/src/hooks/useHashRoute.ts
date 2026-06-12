/* Hash router for the new IA:
     #/library          — Library home (also the default for #/ and unknown)
     #/studio           — Studio (last result or empty state)
     #/studio/:stem     — Studio master-detail, deep-linkable per file
     #/capture          — Capture drawer open (over the current view)
     #/acoustics        — real navigation to the separately-built sub-app
   Legacy hashes (#/capture, #/library, #/studio) map 1:1, so old bookmarks
   keep working. */

import { useCallback, useSyncExternalStore } from 'react';

export interface Route {
  view: 'library' | 'studio';
  stem: string | null;
  captureOpen: boolean;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const parts = raw.split('/').filter(Boolean);
  const head = parts[0] ?? '';
  if (head === 'studio') {
    return { view: 'studio', stem: parts[1] ? decodeURIComponent(parts[1]) : null, captureOpen: false };
  }
  if (head === 'capture') {
    return { view: 'library', stem: null, captureOpen: true };
  }
  return { view: 'library', stem: null, captureOpen: false };
}

export function routeToHash(r: Route): string {
  if (r.captureOpen) return '#/capture';
  if (r.view === 'studio') return r.stem ? `#/studio/${encodeURIComponent(r.stem)}` : '#/studio';
  return '#/library';
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

function getSnapshot(): string {
  return location.hash;
}

export function navigate(r: Route): void {
  const h = routeToHash(r);
  if (location.hash !== h) location.hash = h;
}

export function useHashRoute(): { route: Route; navigate: (r: Route) => void } {
  const hash = useSyncExternalStore(subscribe, getSnapshot);
  const route = parseHash(hash);
  const nav = useCallback((r: Route) => navigate(r), []);
  return { route, navigate: nav };
}

/* Convenience navigators */
export const goLibrary = (): void => navigate({ view: 'library', stem: null, captureOpen: false });
export const goStudio = (stem?: string | null): void =>
  navigate({ view: 'studio', stem: stem ?? null, captureOpen: false });
export const openCapture = (): void => navigate({ view: 'library', stem: null, captureOpen: true });
