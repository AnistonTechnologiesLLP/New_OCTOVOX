/* First-run onboarding — React-ified port of ux.js Onboard + Hints
   (lines 182-285), adapted to the new IA: the primary action is the '+ New'
   capture button (app bar on desktop, bottom tab bar on mobile), so the
   coachmark anchors there instead of the legacy Record button.

   - Coachmark: localStorage `octovox.onboarded.v1` (contract table §6.3);
     shows 700 ms after boot, positioned under the visible '+ New' anchor
     (flips above on overflow, arrow tracks the anchor, viewport-clamped);
     Skip dismisses, "Try a sample" opens the capture drawer on the Sample
     tab; ANY navigation marks-as-seen and removes it (ux.js:236-239).
   - KbdHint: one-time "? shortcuts / Ctrl K commands / / search" bar,
     localStorage `octovox.hint.kbd.v1`, X dismiss, auto-dismiss after 12 s. */

import { useEffect, useRef, useState } from 'react';
import { selectCaptureTab } from '../../features/capture/CaptureDrawer';
import { openCapture } from '../../hooks/useHashRoute';

const ONBOARD_KEY = 'octovox.onboarded.v1';
const HINT_KEY = 'octovox.hint.kbd.v1';

const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null; // private mode: legacy showed the hints every visit too
  }
};
const lsSet = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

/** The visible '+ New' button — AppBar on desktop, BottomTabBar on mobile. */
function findAnchor(): HTMLElement | null {
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-coach="new"]'));
  return els.find((el) => el.getBoundingClientRect().width > 0) ?? null;
}

interface CoachPos {
  left: number;
  top: number;
  arrow: number;
  above: boolean;
}

export default function Coachmark() {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<CoachPos | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lsGet(ONBOARD_KEY)) return;
    const t = setTimeout(() => setVisible(true), 700);
    return () => clearTimeout(t);
  }, []);

  // Place under/above the anchor (ux.js:217-226); re-place on resize.
  useEffect(() => {
    if (!visible) return;
    const placeNow = (): void => {
      const anchor = findAnchor();
      const card = cardRef.current;
      if (!anchor || !card) return;
      const r = anchor.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      let left = r.left + r.width / 2 - cr.width / 2;
      left = Math.max(16, Math.min(left, window.innerWidth - cr.width - 16));
      let top = r.bottom + 16;
      let above = false;
      if (top + cr.height > window.innerHeight - 16) {
        top = Math.max(16, r.top - cr.height - 16);
        above = true;
      }
      const arrow = Math.max(16, Math.min(r.left + r.width / 2 - left, cr.width - 16));
      setPos({ left, top, arrow, above });
    };
    placeNow();
    window.addEventListener('resize', placeNow);
    return () => window.removeEventListener('resize', placeNow);
  }, [visible]);

  const done = (): void => {
    lsSet(ONBOARD_KEY, '1');
    setVisible(false);
  };

  // Navigating anywhere marks onboarding as seen and removes the card so it
  // never floats over an unrelated screen (ux.js:236-239).
  useEffect(() => {
    if (!visible) return;
    const onHash = (): void => done();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      ref={cardRef}
      className={`ux-coach${pos ? ' show' : ''}${pos?.above ? ' above' : ''}`}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
      role="dialog"
      aria-label="Getting started"
    >
      <div className="ux-coach-step">Step 1 of 1 / Getting started</div>
      <div className="ux-coach-title">Make your first clean voice</div>
      <div className="ux-coach-body">
        Hit <b>+ New</b> to record live, upload a .wav, or generate a <b>Sample</b> with no
        hardware - OCTOVOX runs the full pipeline and drops the result in your Library.
      </div>
      <div className="ux-coach-actions">
        <button type="button" className="btn btn-ghost" onClick={done}>
          Skip
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            done();
            openCapture();
            selectCaptureTab('sample');
          }}
        >
          Try a sample
        </button>
      </div>
      <div className="ux-coach-arrow" style={{ left: pos?.arrow ?? 16 }} />
    </div>
  );
}

export function KbdHint() {
  const [mounted, setMounted] = useState(() => !lsGet(HINT_KEY));
  const [show, setShow] = useState(false);
  const dismissed = useRef(false);

  useEffect(() => {
    if (!mounted) return;
    const raf = requestAnimationFrame(() => setShow(true));
    const auto = setTimeout(() => dismiss(), 12000); // never nags (ux.js:284)
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(auto);
    };
  }, [mounted]);

  const dismiss = (): void => {
    if (dismissed.current) return;
    dismissed.current = true;
    lsSet(HINT_KEY, '1');
    setShow(false);
    setTimeout(() => setMounted(false), 220);
  };

  if (!mounted) return null;

  return (
    <div className={`ux-kbd-hint${show ? ' show' : ''}`} role="status">
      <span>
        <kbd>?</kbd> shortcuts / <kbd>Ctrl K</kbd> commands / <kbd>/</kbd> search
      </span>
      <button type="button" className="ux-kbd-x" aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
