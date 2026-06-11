/* ═══════════════════════════════════════════════════════════════════
   OCTOVOX — In-app error log  (progressive enhancement, loads after app.js)
   --------------------------------------------------------------------
   A lightweight, self-contained diagnostics panel so you can see what went
   wrong WITHOUT opening the terminal or a log file. It captures from the sinks
   the app ALREADY uses — no app.js rewrites required:

     · window 'error' / 'unhandledrejection'  (uncaught JS + promise failures)
     · console.error / console.warn           (wrapped, originals still fire —
                                                the app's global trap + every
                                                catch block console.error()s)
     · failed fetch() responses                (wrapped — non-2xx API calls)

   Entries are kept in a capped ring buffer mirrored to localStorage (so they
   survive a reload), shown in a modal opened from the command palette
   ("View error log") or with the `E` shortcut. A small dot on the Commands
   trigger flags unseen errors.

   Opt-out: nothing is sent anywhere — this is local-only.
═══════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const MAX = 50;                         // ring-buffer size
  const KEY = "octovox.errorlog.v1";
  const SEEN_KEY = "octovox.errorlog.seen.v1";
  const $ = id => document.getElementById(id);
  const qs = sel => document.querySelector(sel);

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  // ── store ───────────────────────────────────────────────────────────────
  const Store = {
    items: [],
    load() {
      try { this.items = JSON.parse(ls.get(KEY, "[]")) || []; } catch { this.items = []; }
    },
    save() { ls.set(KEY, JSON.stringify(this.items.slice(-MAX))); },
    add(entry) {
      // de-dupe a burst of the identical message within 1.5s (e.g. retried fetch)
      const last = this.items[this.items.length - 1];
      if (last && last.msg === entry.msg && (entry.ts - last.ts) < 1500) {
        last.count = (last.count || 1) + 1;
        last.ts = entry.ts;
      } else {
        this.items.push(entry);
        if (this.items.length > MAX) this.items = this.items.slice(-MAX);
      }
      this.save();
      UI.onNew();
    },
    clear() { this.items = []; this.save(); UI.render(); UI.refreshBadge(); },
    unseenCount() {
      const seen = +ls.get(SEEN_KEY, "0") || 0;
      return this.items.filter(e => e.ts > seen).length;
    },
    markSeen() { ls.set(SEEN_KEY, String(Date.now())); },
  };

  function record(type, msg, detail) {
    if (!msg) return;
    // never let logging throw / recurse
    try {
      Store.add({
        ts: Date.now(),
        type: type || "error",
        msg: String(msg).slice(0, 600),
        detail: detail ? String(detail).slice(0, 2000) : "",
        where: (location.hash || "").replace(/^#\//, "") || "capture",
      });
    } catch {}
  }
  // expose for any code that wants to log explicitly
  window.octovoxLogError = (msg, detail) => record("error", msg, detail);

  // ── capture: hook the existing sinks (originals always still run) ────────
  function installHooks() {
    window.addEventListener("error", e => {
      const err = e.error;
      record("error", e.message || "Uncaught error",
             err && err.stack ? err.stack : (e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : ""));
    });
    window.addEventListener("unhandledrejection", e => {
      const r = e.reason;
      record("error", (r && r.message) || String(r || "Unhandled rejection"),
             r && r.stack ? r.stack : "");
    });

    // console.error / console.warn — keep originals, also record.
    ["error", "warn"].forEach(level => {
      const orig = console[level] ? console[level].bind(console) : function () {};
      console[level] = function (...args) {
        orig(...args);
        try {
          const msg = args.map(a =>
            (a && a.message) ? a.message :
            (typeof a === "object") ? safeJson(a) : String(a)).join(" ");
          // skip our own re-logging noise
          if (!/\[errlog\]/.test(msg)) record(level === "warn" ? "warn" : "error", msg,
            args.find(a => a && a.stack) ? args.find(a => a.stack).stack : "");
        } catch {}
      };
    });

    // NB: toast() is called by bare name in app.js (a hoisted function
    // declaration), so reassigning window.toast would NOT intercept those calls.
    // We deliberately rely on the reliable sinks instead — console.error/warn,
    // the window error handlers, and failed fetch()es — which DO capture the
    // app's real failures (its global trap + catch blocks all console.error).

    // fetch() — record non-OK API responses with the URL + status.
    if (window.fetch) {
      const origFetch = window.fetch.bind(window);
      window.fetch = async function (input, init) {
        const url = (typeof input === "string") ? input : (input && input.url) || "";
        try {
          const res = await origFetch(input, init);
          if (!res.ok && /\/api\//.test(url)) {
            record("error", `HTTP ${res.status} · ${shortUrl(url)}`,
                   `${(init && init.method) || "GET"} ${url}`);
          }
          return res;
        } catch (e) {
          if (/\/api\//.test(url)) record("error", `Network error · ${shortUrl(url)}`, String(e));
          throw e;   // never swallow — callers handle it as before
        }
      };
    }
  }

  function shortUrl(u) { try { return new URL(u, location.href).pathname; } catch { return u; } }
  function safeJson(o) { try { return JSON.stringify(o); } catch { return String(o); } }

  // ── UI: modal viewer + badge ─────────────────────────────────────────────
  const UI = {
    root: null,
    open: false,
    build() {
      const root = document.createElement("div");
      root.id = "errlogRoot";
      root.className = "errlog-root hidden";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-label", "Error log");
      root.innerHTML = `
        <div class="errlog-backdrop"></div>
        <div class="errlog-panel">
          <div class="errlog-head">
            <div class="errlog-title">⚑ Error log <span class="errlog-count" id="errlogCount"></span></div>
            <div class="errlog-actions">
              <button class="errlog-btn" id="errlogCopy" title="Copy all entries">⧉ Copy</button>
              <button class="errlog-btn" id="errlogClear" title="Clear the log">🗑 Clear</button>
              <button class="errlog-btn errlog-x" id="errlogClose" aria-label="Close">✕</button>
            </div>
          </div>
          <div class="errlog-list" id="errlogList"></div>
          <div class="errlog-foot">Local only · last ${MAX} events · <kbd>E</kbd> opens this</div>
        </div>`;
      document.body.appendChild(root);
      this.root = root;
      root.querySelector(".errlog-backdrop").addEventListener("click", () => this.close());
      $("errlogClose").addEventListener("click", () => this.close());
      $("errlogClear").addEventListener("click", () => {
        Store.clear();
      });
      $("errlogCopy").addEventListener("click", () => this.copyAll());
    },
    render() {
      const list = $("errlogList");
      if (!list) return;
      const items = Store.items.slice().reverse();
      $("errlogCount").textContent = items.length ? `${items.length}` : "";
      if (!items.length) {
        list.innerHTML = `<div class="errlog-empty">✓ No errors logged. Nice.</div>`;
        return;
      }
      list.innerHTML = items.map(e => {
        const t = new Date(e.ts);
        const time = t.toLocaleTimeString();
        const date = t.toLocaleDateString();
        const cls = e.type === "warn" ? "warn" : "error";
        const mult = e.count && e.count > 1 ? ` <span class="errlog-mult">×${e.count}</span>` : "";
        const detail = e.detail
          ? `<pre class="errlog-detail">${esc(e.detail)}</pre>` : "";
        return `
          <div class="errlog-item ${cls}">
            <div class="errlog-item-top">
              <span class="errlog-tag errlog-tag-${cls}">${cls.toUpperCase()}</span>
              <span class="errlog-msg">${esc(e.msg)}${mult}</span>
            </div>
            <div class="errlog-meta">${esc(time)} · ${esc(date)} · <span class="errlog-where">${esc(e.where)}</span></div>
            ${detail}
          </div>`;
      }).join("");
    },
    show() {
      if (!this.root) this.build();
      this.render();
      this.root.classList.remove("hidden");
      this.open = true;
      Store.markSeen();
      this.refreshBadge();
      setTimeout(() => { const c = $("errlogClose"); if (c) c.focus(); }, 20);
    },
    close() {
      if (this.root) this.root.classList.add("hidden");
      this.open = false;
    },
    toggle() { this.open ? this.close() : this.show(); },
    onNew() {
      if (this.open) this.render();
      this.refreshBadge();
    },
    refreshBadge() {
      const trig = $("cmdkTrigger");
      if (!trig) return;
      let dot = trig.querySelector(".errlog-dot");
      const n = Store.unseenCount();
      if (n > 0) {
        if (!dot) {
          dot = document.createElement("span");
          dot.className = "errlog-dot";
          trig.appendChild(dot);
        }
        dot.textContent = n > 9 ? "9+" : String(n);
        dot.title = `${n} unseen error${n === 1 ? "" : "s"}`;
      } else if (dot) {
        dot.remove();
      }
    },
    copyAll() {
      const text = Store.items.map(e => {
        const ts = new Date(e.ts).toISOString();
        return `[${ts}] ${e.type.toUpperCase()} (${e.where})${e.count > 1 ? ` x${e.count}` : ""}: ${e.msg}` +
               (e.detail ? `\n    ${e.detail.replace(/\n/g, "\n    ")}` : "");
      }).join("\n");
      const done = () => toastSafe("Error log copied to clipboard");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
      } else fallbackCopy(text, done);
    },
  };

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      done && done();
    } catch {}
  }
  function toastSafe(m) { try { if (typeof toast === "function") toast(m); } catch {} }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, m =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  // public API used by the command palette + shortcut
  window.OctovoxErrors = {
    open: () => UI.show(),
    close: () => UI.close(),
    toggle: () => UI.toggle(),
    log: (msg, detail) => record("error", msg, detail),
    clear: () => Store.clear(),
    count: () => Store.items.length,
  };

  // `E` shortcut (when not typing, no modal/palette open)
  window.addEventListener("keydown", e => {
    if (e.key !== "e" && e.key !== "E") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement;
    const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
                          el.tagName === "SELECT" || el.isContentEditable);
    if (typing) return;
    // don't fight the command palette if it's open
    if (window.Shell && window.Shell.cmdk && window.Shell.cmdk.isOpen && window.Shell.cmdk.isOpen()) return;
    if (UI.root && UI.open) { UI.close(); return; }
    e.preventDefault();
    UI.show();
  });

  function boot() {
    Store.load();
    installHooks();
    UI.refreshBadge();
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 0));
  else setTimeout(boot, 0);
})();
