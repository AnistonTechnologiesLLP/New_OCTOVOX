/* ═══════════════════════════════════════════════════════════════════
   OCTOVOX — App shell  (Router + Theme manager + Command palette)
   Loaded BEFORE app.js. Defines window.Shell at parse time; all DOM
   wiring is deferred to Shell.afterAppInit(), which app.js calls at the
   end of its DOMContentLoaded init (so state + handlers already exist).
   Globals from app.js (state, toast, showModal, refreshFiles, …) live in
   the shared classic-script scope and are referenced by bare name at
   call time (guarded where it matters).
═══════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const qsa = sel => Array.from(document.querySelectorAll(sel));
  const typingField = () => {
    const el = document.activeElement;
    if (!el) return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
           el.tagName === "SELECT" || el.isContentEditable;
  };
  const cssEsc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\\]]/g, "\\$&");
  const clickIf = id => { const b = $(id); if (b) b.click(); };
  const selectTab = name => { const t = document.querySelector(`.tab[data-tab="${name}"]`); if (t) t.click(); };

  /* ─────────────────────────── THEME ─────────────────────────── */
  const Theme = {
    KEY: "octovox-theme",
    pref() { try { return localStorage.getItem(this.KEY) || "system"; } catch (e) { return "system"; } },
    resolved() { return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"; },
    apply(pref) {
      const sysDark = matchMedia("(prefers-color-scheme: dark)").matches;
      const mode = pref === "system" ? (sysDark ? "dark" : "light") : pref;
      document.documentElement.setAttribute("data-theme", mode);
      this._syncBtn(mode);
      try { if (typeof refreshThemedJsColors === "function") refreshThemedJsColors(); } catch (e) {}
    },
    set(pref) { try { localStorage.setItem(this.KEY, pref); } catch (e) {} this.apply(pref); },
    toggle() { this.set(this.resolved() === "light" ? "dark" : "light"); },
    _syncBtn(mode) {
      const tb = $("themeToggle"); if (!tb) return;
      const ico = tb.querySelector(".tt-ico"), lab = tb.querySelector(".tt-lab");
      if (ico) ico.textContent = mode === "light" ? "☀" : "☾";
      if (lab) lab.textContent = mode === "light" ? "Light" : "Dark";
    },
    init() {
      this.apply(this.pref());
      const tb = $("themeToggle"); if (tb) tb.addEventListener("click", () => this.toggle());
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (this.pref() === "system") this.apply("system");
      });
      window.addEventListener("storage", e => { if (e.key === this.KEY) this.apply(e.newValue || "system"); });
    },
  };

  /* ─────────────────────────── ROUTER ─────────────────────────── */
  const VIEWS = ["capture", "library", "studio"];
  const META = {
    capture: { title: "Capture", sub: "Record, upload, or generate — then clean." },
    library: { title: "Library", sub: "Your recordings — clean, re-view, rename, or delete." },
    studio:  { title: "Studio",  sub: "Compare raw vs clean, tune the pipeline, export." },
  };
  const Router = {
    current: null,
    _suppress: false,
    isStudioReady() { try { return !!(state && state.currentStem); } catch (e) { return false; } },
    refreshGate() {
      const item = document.querySelector('.nav-item[data-view="studio"]');
      if (item) item.classList.toggle("nav-item-gated", !this.isStudioReady());
    },
    navigate(view) {
      if (!VIEWS.includes(view)) view = "capture";
      if (view === "studio" && !this.isStudioReady()) {
        try { toast("Clean a file first to open the Studio.", "warn"); } catch (e) {}
        view = (this.current && this.current !== "studio") ? this.current : "capture";
      }
      this.current = view;
      qsa(".view").forEach(v => v.classList.toggle("view--active", v.dataset.view === view));
      qsa(".nav-item[data-view]").forEach(n => n.classList.toggle("active", n.dataset.view === view));
      const m = META[view] || { title: view, sub: "" };
      if ($("wsTitle")) $("wsTitle").textContent = m.title;
      if ($("wsSub")) $("wsSub").textContent = m.sub;
      qsa("#wsActions [data-view]").forEach(b => b.classList.toggle("hidden", b.dataset.view !== view));
      const shell = document.querySelector(".shell"); if (shell) shell.classList.remove("sidebar-open");
      const ws = $("workspace"); if (ws) ws.scrollTop = 0;
      const h = "#/" + view;
      if (location.hash !== h) { this._suppress = true; location.hash = h; }
    },
    fromHash() {
      const v = (location.hash.replace(/^#\//, "") || "capture").split("?")[0];
      this.navigate(VIEWS.includes(v) ? v : "capture");
    },
  };
  window.addEventListener("hashchange", () => {
    if (Router._suppress) { Router._suppress = false; return; }
    Router.fromHash();
  });

  /* ─────────────────────── COMMAND PALETTE ─────────────────────── */
  const Cmdk = {
    open: false, filtered: [], sel: 0,
    isOpen() { return this.open; },
    buildActions() {
      const ready = Router.isStudioReady();
      const A = [
        { label: "New recording", hint: "Capture", run: () => { Router.navigate("capture"); selectTab("record"); const b = $("recordBtn"); if (b) b.focus(); } },
        { label: "Upload a WAV", hint: "Capture", run: () => { Router.navigate("capture"); selectTab("upload"); clickIf("browseBtn"); } },
        { label: "Generate sample", hint: "Capture", run: () => { Router.navigate("capture"); selectTab("sample"); const b = $("sampleBtn"); if (b) b.focus(); } },
        { label: "Go to Library", hint: "Files", run: () => Router.navigate("library") },
        { label: "Clean all files", hint: "Library", run: () => clickIf("runAllBtn") },
        { label: "Clear all output", hint: "Library", run: () => clickIf("clearOutputBtn") },
        { label: "Refresh file list", hint: "Library", run: () => clickIf("refreshFiles") },
      ];
      if (ready) A.push(
        { label: "Go to Studio", hint: "Console", run: () => Router.navigate("studio") },
        { label: "Re-run clean", hint: "Studio", run: () => clickIf("rerunProdBtn") },
        { label: "Download clean WAV", hint: "Studio", run: () => clickIf("downloadWinnerBtn") },
        { label: "Open report", hint: "Studio", run: () => clickIf("viewReportBtn") },
        { label: "Play to device", hint: "Studio", run: () => clickIf("playoutBtn") },
        { label: "Detect speakers", hint: "Studio", run: () => clickIf("detectSpeakersBtn") },
      );
      A.push(
        { label: "Open Acoustics", hint: "Tools", run: () => { location.href = "/acoustics"; } },
        { label: "Toggle theme", hint: "View", run: () => Theme.toggle() },
        { label: "Keyboard shortcuts", hint: "Help", run: () => { try { showShortcutsHelp(); } catch (e) {} } },
      );
      // dynamic: jump-to-file from whatever rows are currently rendered
      qsa("#filesList .file-row").forEach(row => {
        const name = row.dataset.name; if (!name) return;
        A.push({
          label: "Open " + name, hint: "File", run: () => {
            Router.navigate("library");
            setTimeout(() => {
              const r = document.querySelector('.file-row[data-name="' + cssEsc(name) + '"]');
              if (r) { r.classList.add("flash-highlight"); r.scrollIntoView({ block: "center" }); r.focus && r.focus(); setTimeout(() => r.classList.remove("flash-highlight"), 2000); }
            }, 60);
          },
        });
      });
      return A;
    },
    _score(label, q) {
      // subsequence match; returns score (higher better) or -1 if no match
      label = label.toLowerCase(); q = q.toLowerCase();
      if (!q) return 0;
      let li = 0, run = 0, best = 0, first = -1, hits = 0;
      for (let qi = 0; qi < q.length; qi++) {
        const c = q[qi]; let found = false;
        while (li < label.length) { if (label[li] === c) { if (first < 0) first = li; found = true; run++; best = Math.max(best, run); li++; hits++; break; } else { run = 0; li++; } }
        if (!found) return -1;
      }
      return 100 + best * 5 - first - (label.length - hits) * 0.1;
    },
    render() {
      const q = $("cmdkInput").value.trim();
      let acts = this.buildActions().map(a => ({ a, s: this._score(a.label, q) })).filter(x => x.s >= 0);
      acts.sort((x, y) => y.s - x.s);
      this.filtered = acts.slice(0, 9).map(x => x.a);
      this.sel = 0;
      const list = $("cmdkList");
      list.innerHTML = this.filtered.length
        ? this.filtered.map((a, i) =>
            `<li class="cmdk-item${i === 0 ? " sel" : ""}" role="option" data-i="${i}">
               <span class="cmdk-item-lab">${(a.label).replace(/[&<>]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]))}</span>
               <span class="cmdk-item-hint">${a.hint || ""}</span></li>`).join("")
        : `<li class="cmdk-empty">No matching commands</li>`;
      list.querySelectorAll(".cmdk-item").forEach(el => {
        el.addEventListener("mousemove", () => this._select(+el.dataset.i));
        el.addEventListener("click", () => { this._select(+el.dataset.i); this.runSel(); });
      });
    },
    _select(i) {
      this.sel = i;
      $("cmdkList").querySelectorAll(".cmdk-item").forEach(el => el.classList.toggle("sel", +el.dataset.i === i));
    },
    move(d) {
      if (!this.filtered.length) return;
      this._select((this.sel + d + this.filtered.length) % this.filtered.length);
      const el = $("cmdkList").querySelector(".cmdk-item.sel");
      if (el) el.scrollIntoView({ block: "nearest" });
    },
    runSel() {
      const a = this.filtered[this.sel]; if (!a) return;
      this.close();
      try { a.run(); } catch (e) { console.error(e); }
    },
    openPalette() {
      this.open = true;
      const root = $("cmdkRoot"); root.classList.remove("hidden");
      const inp = $("cmdkInput"); inp.value = ""; this.render();
      setTimeout(() => inp.focus(), 20);
    },
    close() {
      this.open = false;
      const root = $("cmdkRoot"); if (root) root.classList.add("hidden");
    },
    toggle() { this.open ? this.close() : this.openPalette(); },
    init() {
      const root = $("cmdkRoot"); if (!root) return;
      $("cmdkInput").addEventListener("input", () => this.render());
      root.querySelector(".cmdk-backdrop").addEventListener("click", () => this.close());
      const open = () => this.openPalette();
      const hint = $("cmdkHint"); if (hint) hint.addEventListener("click", open);
      const trig = $("cmdkTrigger"); if (trig) trig.addEventListener("click", open);
    },
  };

  /* capture-phase keydown: runs BEFORE app.js's bubble handler so the palette
     owns Cmd/Ctrl-K, and (when open) arrows/enter/esc — without disturbing
     app.js's single-key shortcuts when the palette is closed. */
  window.addEventListener("keydown", e => {
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && (k === "k" || k === "K")) { e.preventDefault(); e.stopPropagation(); Cmdk.toggle(); return; }
    if (Cmdk.isOpen()) {
      if (k === "Escape")    { e.preventDefault(); e.stopPropagation(); Cmdk.close(); }
      else if (k === "ArrowDown") { e.preventDefault(); e.stopPropagation(); Cmdk.move(1); }
      else if (k === "ArrowUp")   { e.preventDefault(); e.stopPropagation(); Cmdk.move(-1); }
      else if (k === "Enter")     { e.preventDefault(); e.stopPropagation(); Cmdk.runSel(); }
      return;
    }
    if ((k === "t" || k === "T") && !e.ctrlKey && !e.metaKey && !e.altKey && !typingField()) {
      e.preventDefault(); e.stopPropagation(); Theme.toggle();
    }
  }, true);

  /* ─────────────────────── SHELL BOOTSTRAP ─────────────────────── */
  function wireSidebar() {
    const toggle = $("sidebarToggle");
    const shell = document.querySelector(".shell");
    if (toggle && shell) toggle.addEventListener("click", () => shell.classList.toggle("sidebar-open"));
    // nav-items use href="#/view" → hashchange drives the router; no extra handler needed,
    // except the external Acoustics link which is a real navigation (left as-is).
    qsa(".nav-item[data-view]").forEach(n => n.addEventListener("click", e => {
      // let the hash change handle routing, but for the gated studio give instant feedback
      if (n.dataset.view === "studio" && !Router.isStudioReady()) { e.preventDefault(); Router.navigate("studio"); }
    }));
  }

  function afterAppInit() {
    Theme.init();
    Cmdk.init();
    wireSidebar();
    Router.refreshGate();
    Router.fromHash();
  }

  window.Shell = { router: Router, theme: Theme, cmdk: Cmdk, afterAppInit };
})();
