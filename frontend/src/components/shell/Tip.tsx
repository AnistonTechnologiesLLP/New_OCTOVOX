/* Tooltip system — React-ified port of ux.js Tip (lines 31-94).

   TipLayer (default export, mounted once in App) keeps the legacy delegated
   model: a single fixed tooltip element plus document-level mouseover/focusin
   listeners, so EVERY element carrying a native title="" anywhere in the tree
   (file rows, studio knobs, app-bar buttons) gets lazily promoted to a styled
   tooltip — title moved into data-ux-tip (+ aria-label fallback) so the
   browser's own tooltip stops competing. 320 ms hover delay, instant on focus
   or reduced-motion; placed above the anchor with below-flip and viewport
   clamping (max-width 280); hidden on mouseout/focusout/scroll.

   <Tip text="..."> is the explicit wrapper for new code: it stamps the child
   with data-ux-tip directly (skipping the title promotion round-trip). */

import { cloneElement, useEffect, type ReactElement } from 'react';

export function Tip({
  text,
  children,
}: {
  text: string;
  children: ReactElement<Record<string, unknown>>;
}): ReactElement {
  const extra: Record<string, unknown> = { 'data-ux-tip': text };
  if (children.props['aria-label'] == null) extra['aria-label'] = text;
  return cloneElement(children, extra);
}

export default function TipLayer() {
  useEffect(() => {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const el = document.createElement('div');
    el.className = 'ux-tip';
    el.setAttribute('role', 'tooltip');
    document.body.appendChild(el);
    let showT: number | null = null;

    /* Promote title="" to data-ux-tip once, lazily (ux.js:53-66). Checking the
       native title FIRST also re-promotes when React re-renders an element
       with a CHANGED title (e.g. the theme button's "Theme: light/dark"). */
    const promote = (node: Element): string | null => {
      const native = node.getAttribute('title');
      if (native && native.trim()) {
        const txt = native.trim();
        node.setAttribute('data-ux-tip', txt);
        if (!node.getAttribute('aria-label')) node.setAttribute('aria-label', txt);
        node.removeAttribute('title');
        return txt;
      }
      return node.getAttribute('data-ux-tip');
    };

    const place = (node: Element): void => {
      const r = node.getBoundingClientRect();
      el.style.maxWidth = `${Math.min(280, window.innerWidth - 24)}px`;
      // measure at origin first
      el.style.left = '0px';
      el.style.top = '0px';
      const tr = el.getBoundingClientRect();
      let top = r.top - tr.height - 10;
      let below = false;
      if (top < 8) {
        top = r.bottom + 10;
        below = true;
      }
      let left = r.left + r.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.classList.toggle('below', below);
    };

    const hide = (): void => {
      if (showT != null) {
        clearTimeout(showT);
        showT = null;
      }
      el.classList.remove('show');
    };

    const maybeShow = (target: EventTarget | null, instant?: boolean): void => {
      if (!(target instanceof Element)) return;
      const node = target.closest('[title], [data-ux-tip]');
      if (!node) return;
      const txt = promote(node);
      if (!txt) return;
      if (showT != null) clearTimeout(showT);
      const run = (): void => {
        el.textContent = txt;
        el.classList.add('show');
        place(node);
      };
      if (instant || reduceMotion) run();
      else showT = window.setTimeout(run, 320);
    };

    const onOver = (e: MouseEvent): void => maybeShow(e.target);
    const onOut = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('[data-ux-tip]')) hide();
    };
    const onFocusIn = (e: FocusEvent): void => maybeShow(e.target, true);
    const onFocusOut = (): void => hide();
    const onScroll = (): void => hide();

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('scroll', onScroll, true);
      hide();
      el.remove();
    };
  }, []);

  return null;
}
