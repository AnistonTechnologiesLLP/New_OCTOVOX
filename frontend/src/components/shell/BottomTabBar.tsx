import { goLibrary, goStudio, openCapture, type Route } from '../../hooks/useHashRoute';
import { useSession } from '../../state/session';

/* Mobile bottom tab bar (<820px): Library / New / Studio. */
export default function BottomTabBar({ route }: { route: Route }) {
  const currentStem = useSession((s) => s.currentStem);
  return (
    <nav className="bottombar" aria-label="Primary">
      <button
        className={`bottombar-tab${route.view === 'library' && !route.captureOpen ? ' active' : ''}`}
        onClick={goLibrary}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
        <span>Library</span>
      </button>
      <button
        className="bottombar-tab bottombar-new"
        data-coach="new"
        onClick={openCapture}
        aria-label="New capture"
      >
        <span className="bottombar-new-circle">+</span>
        <span>New</span>
      </button>
      <button
        className={`bottombar-tab${route.view === 'studio' ? ' active' : ''}`}
        onClick={() => goStudio(currentStem)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4 10v4m4-8v12m4-10v8m4-11v14m4-10v6" />
        </svg>
        <span>Studio</span>
      </button>
    </nav>
  );
}
