/* Capture drawer — Record / Upload WAV / Sample. Right-side slide-in sheet on
   desktop, full-screen below 820px; opens at #/capture over the current view.
   Ports the legacy capture tabs (app.js:183-216): mobile sample-first default
   on <=640px screens when sessionStorage `octovox.tabChosen` is unset, the
   pointerdown "tab chosen" marker, and a programmatic selection helper for
   the palette / onboarding. */

import { useEffect, useSyncExternalStore } from 'react';
import './capture.css';
import RecordPanel from './RecordPanel';
import SamplePanel from './SamplePanel';
import UploadDropzone from './UploadDropzone';
import { goLibrary } from '../../hooks/useHashRoute';

export type CaptureTab = 'record' | 'upload' | 'sample';

const TABS: { id: CaptureTab; label: string }[] = [
  { id: 'record', label: 'Record' },
  { id: 'upload', label: 'Upload WAV' },
  { id: 'sample', label: 'Sample' },
];

/* Module-scope tab store: the choice survives drawer close/reopen for the
   life of the SPA, like the legacy DOM-held active class. */
let currentTab: CaptureTab = 'record';
const listeners = new Set<() => void>();

function setTab(t: CaptureTab): void {
  if (t === currentTab) return;
  currentTab = t;
  listeners.forEach((l) => l());
}

const subscribeTab = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};
const getTab = (): CaptureTab => currentTab;

/** Programmatic tab selection (legacy selectCaptureTab, app.js:183-186) —
 *  used by shell/palette/onboarding actions ("New recording", "Upload a
 *  WAV", "Generate sample"). */
export function selectCaptureTab(name: CaptureTab): void {
  setTab(name);
}

/* Mobile-first: live multi-channel Record needs the 8-mic array, which a
   phone never has — so on narrow screens lead with Sample unless the user
   has explicitly chosen a tab this session. Applied once, deferred to the
   next frame so layout/media-queries have settled (app.js:199-211). */
let mobileDefaultApplied = false;

/* Record that the user made an explicit tab choice, so the mobile override
   stops for this session (app.js:213-215). */
function markTabChosen(): void {
  try {
    sessionStorage.setItem('octovox.tabChosen', '1');
  } catch { /* private-mode safe */ }
}

export default function CaptureDrawer({ open }: { open: boolean }) {
  const tab = useSyncExternalStore(subscribeTab, getTab);

  useEffect(() => {
    if (!open || mobileDefaultApplied) return;
    mobileDefaultApplied = true;
    const raf = requestAnimationFrame(() => {
      try {
        if (matchMedia('(max-width: 640px)').matches && !sessionStorage.getItem('octovox.tabChosen')) {
          setTab('sample');
        }
      } catch { /* private-mode safe */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!open) return null;
  return (
    <div className="capture-overlay" role="dialog" aria-modal="true" aria-label="New capture">
      <div className="capture-backdrop" onClick={goLibrary} />
      <aside className="capture-drawer">
        <header className="capture-head">
          <h2 className="capture-title">New capture</h2>
          <button className="btn btn-ghost" onClick={goLibrary}>
            Close
          </button>
        </header>
        <div className="capture-tabs" role="tablist" aria-label="Capture mode">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`capture-tab${tab === t.id ? ' active' : ''}`}
              onPointerDown={markTabChosen}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="capture-body">
          {/* All panels stay mounted so device/levels/slider state persists
              across tab switches, matching the legacy hidden-panel DOM. */}
          <div className={`capture-panel${tab === 'record' ? ' active' : ''}`} role="tabpanel" aria-label="Record">
            <RecordPanel />
          </div>
          <div className={`capture-panel${tab === 'upload' ? ' active' : ''}`} role="tabpanel" aria-label="Upload WAV">
            <UploadDropzone />
          </div>
          <div className={`capture-panel${tab === 'sample' ? ' active' : ''}`} role="tabpanel" aria-label="Sample">
            <SamplePanel />
          </div>
        </div>
      </aside>
    </div>
  );
}
