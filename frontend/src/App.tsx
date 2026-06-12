import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import AppBar from './components/shell/AppBar';
import BottomTabBar from './components/shell/BottomTabBar';
import Coachmark, { KbdHint } from './components/shell/Coachmark';
import CommandPalette, { usePalette } from './components/shell/CommandPalette';
import ErrorLogModal, { useErrlogUI } from './components/shell/ErrorLogModal';
import ModalHost from './components/shell/ModalHost';
import { showShortcutsHelp } from './components/shell/ShortcutsHelp';
import TipLayer from './components/shell/Tip';
import ToastHost from './components/shell/ToastHost';
import CaptureDrawer from './features/capture/CaptureDrawer';
import LibraryView from './features/library/LibraryView';
import StickyProgress from './features/studio/StickyProgress';
import StudioView from './features/studio/StudioView';
import { goLibrary, parseHash, useHashRoute } from './hooks/useHashRoute';
import { toggleTheme } from './hooks/useTheme';
import { installErrorHooks } from './lib/errlog';
import { cancelActiveModal, useModal } from './state/modals';
import { installGlobalErrorTrap } from './state/session';
import { toast, useToasts } from './state/toasts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false },
  },
});

installErrorHooks();
installGlobalErrorTrap();

function isTypingInField(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
  );
}

/** Global key handling for the shell: the Esc cascade (modal → newest toast →
 *  row focus, app.js:2174-2188), T (theme), E (error log), ? (shortcuts
 *  help), and App-level fallbacks for '/' and 'R' while the Library is NOT
 *  mounted. Ctrl+K and the palette-open keys live in CommandPalette's own
 *  capture-phase listener (legacy shell.js:221-230); while the palette is
 *  open this bubble handler stands down entirely, mirroring the legacy
 *  early-return (shell.js:224-230) — its Esc never reaches us because the
 *  palette stops propagation in the capture phase. */
function useShellHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (cancelActiveModal()) return;
        if (useErrlogUI.getState().open) { useErrlogUI.getState().close(); return; }
        if (useToasts.getState().dismissNewest()) return;
        // Row-focus clearing is handled inside the Library view.
        return;
      }
      if (usePalette.getState().open) return; // palette owns the keyboard
      if (isTypingInField()) return;
      if (useModal.getState().isOpen()) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === '?') {
        e.preventDefault();
        showShortcutsHelp();
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        toggleTheme();
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        useErrlogUI.getState().toggle();
        return;
      }

      /* '/' and 'R' are owned by the Library's capture-phase listener while
         it is mounted (route view 'library' — its handler runs first and the
         guard below keeps this one quiet). From the Studio they fall back to
         App-level behavior (PORTING.md §5.6 DECISION). */
      if (parseHash(location.hash).view === 'library') return;

      if (e.key === '/') {
        // Navigate to the Library; pressing '/' again focuses the filter
        // (navigation-only hoisting — DECISION, simplest reliable option).
        e.preventDefault();
        goLibrary();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        void queryClient.invalidateQueries({ queryKey: ['files'] });
        void queryClient.invalidateQueries({ queryKey: ['verdict'] });
        toast('Files refreshed');
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function App() {
  const { route } = useHashRoute();
  useShellHotkeys();

  return (
    <QueryClientProvider client={queryClient}>
      <AppBar route={route} />
      <main className="app-main">
        {route.view === 'studio' ? <StudioView stem={route.stem} /> : <LibraryView />}
      </main>
      <BottomTabBar route={route} />
      <CaptureDrawer open={route.captureOpen} />
      <StickyProgress />
      <ToastHost />
      <ModalHost />
      <ErrorLogModal />
      <CommandPalette />
      <TipLayer />
      <Coachmark />
      <KbdHint />
    </QueryClientProvider>
  );
}
