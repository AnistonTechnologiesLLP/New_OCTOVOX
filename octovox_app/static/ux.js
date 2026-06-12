/* ------------------------------------------------------------------
   OCTOVOX - UX layer  (progressive enhancement, loaded after app.js)
   --------------------------------------------------------------------
   Self-contained: adds discoverability + guidance on top of the existing
   app without touching its logic. Everything here is additive and degrades
   gracefully - if a hook element is missing, that feature simply no-ops.

     1. Tooltips - upgrade native title="" into styled hover tooltips
     2. In-context - help popovers on the Studio control groups
     3. Onboarding - first-run "start here" coachmark + richer empties
     4. Discoverability - persistent "press ? for shortcuts" hint, button ripple

   No globals are leaked except window.OctovoxUX (for debugging / re-init).
------------------------------------------------------------------ */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const qs = sel => document.querySelector(sel);
  const qsa = sel => Array.from(document.querySelectorAll(sel));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* TOOLTIPS
     Many controls already carry helpful title="" text, but native
     tooltips are slow to appear and unstyled. We move the text into a
     data-attr (so the browser stops showing its own) and render a soft
     neumorphic tooltip on hover/focus, positioned to stay on-screen. */
  const Tip = {
    el: null,
    showT: null,
    init() {
      this.el = document.createElement("div");
      this.el.className = "ux-tip";
      this.el.setAttribute("role", "tooltip");
      document.body.appendChild(this.el);

      // Delegate so dynamically-rendered rows/controls work too.
      document.addEventListener("mouseover", e => this._maybeShow(e.target));
      document.addEventListener("mouseout", e => {
        const t = e.target.closest && e.target.closest("[data-ux-tip]");
        if (t) this.hide();
      });
      document.addEventListener("focusin", e => this._maybeShow(e.target, true));
      document.addEventListener("focusout", () => this.hide());
      // Scroll / resize invalidate the anchor position.
      window.addEventListener("scroll", () => this.hide(), true);
    },
    // Promote title="" to data-ux-tip="" once, lazily, so we never fight the
    // native tooltip and keep accessibility (we add aria-label as a fallback).
    _promote(node) {
      if (!node.getAttribute) return null;
      let txt = node.getAttribute("data-ux-tip");
      if (!txt) {
        const native = node.getAttribute("title");
        if (native && native.trim()) {
          txt = native.trim();
          node.setAttribute("data-ux-tip", txt);
          if (!node.getAttribute("aria-label")) node.setAttribute("aria-label", txt);
          node.removeAttribute("title");
        }
      }
      return txt;
    },
    _maybeShow(target, instant) {
      const node = target.closest && target.closest("[title], [data-ux-tip]");
      if (!node) return;
      const txt = this._promote(node);
      if (!txt) return;
      clearTimeout(this.showT);
      const run = () => { this.el.textContent = txt; this.el.classList.add("show"); this._place(node); };
      if (instant || reduceMotion) run();
      else this.showT = setTimeout(run, 320);
    },
    _place(node) {
      const r = node.getBoundingClientRect();
      const t = this.el;
      t.style.maxWidth = Math.min(280, window.innerWidth - 24) + "px";
      // measure
      t.style.left = "0px"; t.style.top = "0px";
      const tr = t.getBoundingClientRect();
      let top = r.top - tr.height - 10;
      let placeBelow = false;
      if (top < 8) { top = r.bottom + 10; placeBelow = true; }
      let left = r.left + r.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
      t.style.left = left + "px";
      t.style.top = top + "px";
      t.classList.toggle("below", placeBelow);
    },
    hide() { clearTimeout(this.showT); if (this.el) this.el.classList.remove("show"); },
  };

  /* IN-CONTEXT HELP
     Plain-language explanations of the DSP controls. Rendered as a small
     Help button next to each control-group heading; clicking opens a popover
     anchored to it. Content is written for a non-DSP user. */
  const HELP = {
    "Preset": {
      title: "Presets",
      body: "<b>Quality</b> runs the full neural chain (DeepFilterNet3) for the cleanest result - slower. " +
            "<b>Fast</b> trades a little quality for much lower runtime. " +
            "<b>Custom</b> appears automatically once you change any knob below.",
      tip: "Not sure? Leave it on Quality.",
    },
    "Noise / Beam / Movement / Mask": {
      title: "Noise, beam & direction",
      body: "<b>Noise reduction</b> removes background hiss/hum - <i>Natural</i> sounds best. " +
            "<b>Beam</b> focuses the 8 mics on the speaker; <i>Auto</i> handles both still and moving talkers. " +
            "<b>Movement</b> picks how the beam tracks a walking speaker. " +
            "<b>Mask</b> decides which sound is 'voice' vs 'noise' - <i>Coherence auto</i> is the safe choice.",
      tip: "Defaults work for most rooms.",
    },
    "AGC / AEC / Dereverb": {
      title: "Levelling, echo & room",
      body: "<b>AGC</b> evens out loud/quiet speech to a steady level. " +
            "<b>AEC</b> cancels echo from a loudspeaker - only active if you pick an <b>AEC reference</b> file. " +
            "<b>Dereverb</b> reduces 'boomy room' reflections; leave it <i>None</i> in a dry room. " +
            "<b>Denoise strength</b> sets how hard the noise reducer pushes.",
      tip: "AEC does nothing without a reference file.",
    },
    "Target speaker": {
      title: "Aiming the beam",
      body: "By default OCTOVOX keeps every voice. To isolate one person, click <b>Detect</b> to scan for talkers, " +
            "then click a chip - or click anywhere on the radar to aim the beam in that direction.",
      tip: "Click the radar to steer manually.",
    },
  };
  const Help = {
    pop: null,
    init() {
      this.pop = document.createElement("div");
      this.pop.className = "ux-pop hidden";
      this.pop.innerHTML = `<div class="ux-pop-title"></div><div class="ux-pop-body"></div>
        <div class="ux-pop-tip"></div>`;
      document.body.appendChild(this.pop);
      document.addEventListener("click", e => {
        if (this.pop.contains(e.target)) return;
        if (e.target.closest(".ux-help-btn")) return;
        this.close();
      });
      window.addEventListener("keydown", e => { if (e.key === "Escape") this.close(); });
      window.addEventListener("scroll", () => this.close(), true);
      this.attach();
    },
    // Add a help button to every known control-group heading.
    attach() {
      qsa(".ctl-group-head, .ctl-speaker .ctl-lab").forEach(head => {
        const key = head.textContent.trim();
        const data = HELP[key];
        if (!data || head.querySelector(".ux-help-btn")) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ux-help-btn";
        // The popover IS the explanation - no redundant hover tooltip on top.
        btn.setAttribute("aria-label", `What is ${data.title}?`);
        btn.textContent = "?";
        btn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); this.toggle(btn, data); });
        head.appendChild(btn);
      });
    },
    toggle(anchor, data) {
      if (!this.pop.classList.contains("hidden") && this._anchor === anchor) { this.close(); return; }
      this._anchor = anchor;
      this.pop.querySelector(".ux-pop-title").textContent = data.title;
      this.pop.querySelector(".ux-pop-body").innerHTML = data.body;
      this.pop.querySelector(".ux-pop-tip").textContent = "Tip: " + data.tip;
      this.pop.classList.remove("hidden");
      const r = anchor.getBoundingClientRect();
      const pr = this.pop.getBoundingClientRect();
      let left = r.right + 12;
      if (left + pr.width > window.innerWidth - 12) left = Math.max(12, r.left - pr.width - 12);
      let top = Math.max(12, Math.min(r.top - 4, window.innerHeight - pr.height - 12));
      this.pop.style.left = left + "px";
      this.pop.style.top = top + "px";
    },
    close() { if (this.pop) this.pop.classList.add("hidden"); this._anchor = null; },
  };

  /* ONBOARDING
     A one-time coachmark pointing first-time users at the primary action,
     plus an upgraded Library empty state with a real call-to-action. */
  const Onboard = {
    KEY: "octovox.onboarded.v1",
    init() {
      this.enrichEmptyState();
      if (ls.get(this.KEY)) return;
      // Wait for the capture view + record button to exist and be visible.
      const target = $("recordBtn");
      if (!target) return;
      // Only coach on the Capture view (the default landing view).
      const onCapture = () => (location.hash || "#/capture").startsWith("#/capture");
      if (!onCapture()) return;
      setTimeout(() => this.show(target), 700);
    },
    show(target) {
      if (ls.get(this.KEY)) return;
      const r = target.getBoundingClientRect();
      if (!r.width) return;
      const card = document.createElement("div");
      card.className = "ux-coach";
      card.innerHTML = `
        <div class="ux-coach-step">Step 1 of 1 / Getting started</div>
        <div class="ux-coach-title">Make your first clean voice</div>
        <div class="ux-coach-body">
          Pick a tab above - <b>Record</b> live, <b>Upload</b> a .wav, or generate a <b>Sample</b> with no
          hardware - then hit the green button. OCTOVOX runs the full pipeline and drops the result in your Library.
        </div>
        <div class="ux-coach-actions">
          <button class="ux-coach-skip" type="button">Dismiss</button>
          <button class="ux-coach-try" type="button">Try a sample</button>
        </div>
        <div class="ux-coach-arrow"></div>`;
      document.body.appendChild(card);
      const cr = card.getBoundingClientRect();
      let left = r.left + r.width / 2 - cr.width / 2;
      left = Math.max(16, Math.min(left, window.innerWidth - cr.width - 16));
      let top = r.bottom + 16;
      // flip above if it would overflow the viewport
      if (top + cr.height > window.innerHeight - 16) top = Math.max(16, r.top - cr.height - 16);
      card.style.left = left + "px";
      card.style.top = top + "px";
      card.querySelector(".ux-coach-arrow").style.left =
        Math.max(16, Math.min(r.left + r.width / 2 - left, cr.width - 16)) + "px";
      requestAnimationFrame(() => card.classList.add("show"));

      const done = () => {
        ls.set(this.KEY, "1");
        card.classList.remove("show");
        window.removeEventListener("hashchange", onLeave);
        setTimeout(() => card.remove(), 220);
      };
      // The coachmark is anchored to the Capture view - if the user navigates
      // elsewhere it must not float over an unrelated screen. Mark onboarding
      // as seen so it doesn't pop back up, and tidy up.
      const onLeave = () => { if (!(location.hash || "#/capture").startsWith("#/capture")) done(); };
      window.addEventListener("hashchange", onLeave);
      card.querySelector(".ux-coach-skip").addEventListener("click", done);
      card.querySelector(".ux-coach-try").addEventListener("click", () => {
        done();
        const tab = qs('.tab[data-tab="sample"]'); if (tab) tab.click();
        const btn = $("sampleBtn"); if (btn) { btn.focus(); btn.classList.add("ux-attention"); setTimeout(() => btn.classList.remove("ux-attention"), 2400); }
      });
    },
    // Give the Library empty state an action so it's not a dead end.
    enrichEmptyState() {
      const empty = $("filesEmpty");
      if (!empty || empty.querySelector(".ux-empty-cta")) return;
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "btn btn-primary btn-sm ux-empty-cta";
      cta.textContent = "Generate a sample to try it";
      cta.addEventListener("click", () => {
        if (window.Shell && window.Shell.router) window.Shell.router.navigate("capture");
        const tab = qs('.tab[data-tab="sample"]'); if (tab) tab.click();
        const btn = $("sampleBtn"); if (btn) { btn.focus(); btn.click(); }
      });
      empty.appendChild(cta);
    },
  };

  /* DISCOVERABILITY
     A subtle, dismissable hint that the command palette + shortcuts exist,
     and a soft ripple on button presses so the UI feels responsive. */
  const Hints = {
    KEY: "octovox.hint.kbd.v1",
    init() {
      this.shortcutsHint();
      this.buttonRipple();
    },
    shortcutsHint() {
      if (ls.get(this.KEY)) return;
      const bar = document.createElement("div");
      bar.className = "ux-kbd-hint";
      bar.innerHTML = `<span><kbd>?</kbd> shortcuts / <kbd>Ctrl K</kbd> commands / <kbd>/</kbd> search</span>
        <button class="ux-kbd-x" aria-label="Dismiss">X</button>`;
      document.body.appendChild(bar);
      requestAnimationFrame(() => bar.classList.add("show"));
      const close = () => { ls.set(this.KEY, "1"); bar.classList.remove("show"); setTimeout(() => bar.remove(), 220); };
      bar.querySelector(".ux-kbd-x").addEventListener("click", close);
      // auto-dismiss after a while so it never nags
      setTimeout(close, 12000);
    },
    buttonRipple() {
      if (reduceMotion) return;
      // Neumorphism already signals press via the inset shadow, so the ripple is
      // reserved for the accent CTAs where a positive "go" confirmation helps -
      // not every surface (which would feel off-language for soft-UI).
      document.addEventListener("pointerdown", e => {
        const btn = e.target.closest && e.target.closest(".btn-primary, .ab-play, .modal-btn.primary");
        if (!btn || btn.disabled) return;
        const r = btn.getBoundingClientRect();
        const span = document.createElement("span");
        span.className = "ux-ripple";
        const size = Math.max(r.width, r.height);
        span.style.width = span.style.height = size + "px";
        span.style.left = (e.clientX - r.left - size / 2) + "px";
        span.style.top = (e.clientY - r.top - size / 2) + "px";
        const prevPos = getComputedStyle(btn).position;
        if (prevPos === "static") btn.style.position = "relative";
        btn.appendChild(span);
        span.addEventListener("animationend", () => span.remove());
      });
    },
  };

  /* BOOTSTRAP */
  function boot() {
    Tip.init();
    Help.init();
    Onboard.init();
    Hints.init();
    // Re-attach help buttons after the files/controls re-render (they're
    // rebuilt by app.js). A light MutationObserver keeps help buttons present.
    const obs = new MutationObserver(() => { Help.attach(); Onboard.enrichEmptyState(); });
    const root = qs(".views") || document.body;
    obs.observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }

  window.OctovoxUX = { Tip, Help, Onboard, Hints, reattach: () => { Help.attach(); Onboard.enrichEmptyState(); } };
})();
