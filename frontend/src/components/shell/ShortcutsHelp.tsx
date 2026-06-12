/* Keyboard-shortcuts cheat sheet — ports showShortcutsHelp (app.js:2148-2170)
   through the shared modal store. The grid lists the legacy nine shortcuts
   plus T (theme) and Ctrl+K (palette), which the old console only advertised
   in the sidebar pill / kbd-hint bar (sanctioned addition, PORTING.md §6.4
   DECISION). Same closing line about typing fields. */

import { showModal } from '../../state/modals';

const ROWS: [key: string, desc: string][] = [
  ['Up / Down', 'Move between file rows'],
  ['Enter', 'Analyse or view the focused file'],
  ['D', 'Delete the focused file'],
  ['R', 'Refresh files list'],
  ['/', 'Jump to filter search'],
  ['A', 'Flip RAW/CLEAN in the Studio'],
  ['E', 'Open the error log'],
  ['T', 'Toggle light/dark theme'],
  ['Ctrl K', 'Open the command palette'],
  ['Esc', 'Close modal or dismiss toast'],
  ['?', 'Show this help'],
];

export function showShortcutsHelp(): void {
  void showModal({
    icon: 'KEY',
    title: 'Keyboard shortcuts',
    body: (
      <>
        <div className="shortcuts-grid">
          {ROWS.map(([key, desc]) => (
            <div key={key} style={{ display: 'contents' }}>
              <div className="sc-key">{key}</div>
              <div className="sc-desc">{desc}</div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14 }}>
          Shortcuts are disabled while typing in a text field.
        </p>
      </>
    ),
    buttons: [{ id: 'ok', label: 'Got it', variant: 'primary' }],
  });
}
