import { goLibrary, goStudio, openCapture, type Route } from '../../hooks/useHashRoute';
import { useTheme } from '../../hooks/useTheme';
import { useSession } from '../../state/session';
import { usePalette } from './CommandPalette';
import EngineChip from './EngineChip';
import { useErrlogUI, useUnseenErrors } from './ErrorLogModal';
import { Tip } from './Tip';

const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform);

function Logo() {
  return (
    <svg viewBox="0 0 64 64" width="22" height="22" aria-hidden="true">
      <circle cx="32" cy="32" r="28" fill="var(--accent)" />
      <text
        x="32"
        y="43"
        fontFamily="var(--mono)"
        fontSize="34"
        fontWeight="800"
        textAnchor="middle"
        fill="var(--text-on-accent)"
      >
        O
      </text>
    </svg>
  );
}

export default function AppBar({ route }: { route: Route }) {
  const { mode, toggle } = useTheme();
  const unseen = useUnseenErrors();
  const showErrlog = useErrlogUI((s) => s.show);
  const currentStem = useSession((s) => s.currentStem);

  return (
    <header className="appbar">
      <a
        className="appbar-brand"
        href="#/library"
        onClick={(e) => {
          e.preventDefault();
          goLibrary();
        }}
      >
        <Logo />
        <span className="appbar-name">OCTOVOX</span>
      </a>

      <nav className="appbar-nav" aria-label="Primary">
        <button
          className={`appbar-link${route.view === 'library' && !route.captureOpen ? ' active' : ''}`}
          onClick={goLibrary}
        >
          Library
        </button>
        <button
          className={`appbar-link${route.view === 'studio' ? ' active' : ''}`}
          onClick={() => goStudio(currentStem)}
        >
          Studio
        </button>
        <a className="appbar-link" href="/acoustics">
          Acoustics
        </a>
      </nav>

      <div className="appbar-actions">
        <EngineChip />
        <Tip text={`Command palette — ${IS_MAC ? '⌘' : 'Ctrl+'}K`}>
          <button className="appbar-cmdk" onClick={() => usePalette.getState().show()}>
            {IS_MAC ? '⌘K' : 'Ctrl K'}
          </button>
        </Tip>
        <button className="btn btn-primary appbar-new" data-coach="new" onClick={openCapture}>
          + New
        </button>
        <button
          className="appbar-icon-btn"
          title={`Errors${unseen ? ` (${unseen} unseen)` : ''} — E`}
          aria-label="Open error log"
          onClick={showErrlog}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          {unseen > 0 && <span className="errlog-dot">{unseen > 9 ? '9+' : unseen}</span>}
        </button>
        <button
          className="appbar-icon-btn"
          title={`Theme: ${mode} — T`}
          aria-label="Toggle theme"
          onClick={toggle}
        >
          {mode === 'light' ? (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}
