/* ═══════════════════════════════════════════════════════════════════
   OCTOVOX — Frontend App
═══════════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);
const qs = sel => document.querySelector(sel);
const qsa = sel => Array.from(document.querySelectorAll(sel));

const REQUIRED_CH = 8;
const REQUIRED_SR = 48000;

const STAGE_KEYWORDS = {
  load:   ["Loaded"],
  stft:   ["STFT"],
  mask:   ["mask"],
  csm:    ["CSM", "RTF"],
  bf:     ["Beamformer", "beamformers"],
  wpe:    ["WPE", "Neural-MVDR"],
  boot:   ["bootstrap", "Winner"],
  render: ["Saved", "visualization", "report", "metrics.json", "DONE"],
};

const state = {
  currentStem: null,
  currentMetrics: null,
  wsInput: null,
  wsWinner: null,
  recording: false,
  selectedFile: null,       // last file selected for processing / detect
  targetAz: null,           // speaker azimuth to extract (null = all voices)
  interfererAz: null,       // other detected azimuths (passed with targetAz)
  detectedSpeakers: [],     // last result from /api/speakers
  speakersFile: null,       // filename the current speaker list belongs to
};


/* ═══════════════════ BUSY CONTROLLER ═══════════════════
 * Enforces "one operation at a time" across the whole app.
 * Acquire returns false if something is already running (and toasts
 * a friendly explanation). Release is idempotent and ALWAYS safe to
 * call — call it in a finally{} block for any operation that acquires.
 * Includes a 5-minute auto-release watchdog so a stuck operation can
 * never permanently lock the UI.
 */
const Busy = {
  active: false,
  what: null,
  acquiredAt: 0,
  _watchdog: null,

  acquire(what) {
    if (this.active) {
      toast(`⏳ Wait — ${this.what} is still running. Try again when it finishes.`, "warn");
      return false;
    }
    this.active = true;
    this.what = what;
    this.acquiredAt = Date.now();
    document.body.classList.add("octovox-busy");
    // Watchdog: auto-release after 5 min so the UI can never permanently freeze.
    if (this._watchdog) clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (this.active) {
        console.warn("[Busy] watchdog auto-release after 5 min:", this.what);
        toast(`⚠ Operation "${this.what}" took too long — UI unlocked. Check the server terminal for errors.`, "warn");
        this.release();
        try { hideProgress(); } catch {}
      }
    }, 5 * 60 * 1000);
    return true;
  },

  release() {
    this.active = false;
    this.what = null;
    this.acquiredAt = 0;
    document.body.classList.remove("octovox-busy");
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
  },

  isBusy() { return this.active; },
};


/* ═══════════════════ GLOBAL ERROR TRAP ═══════════════════
 * Any uncaught JS error or unhandled promise rejection is surfaced
 * to the user as a toast AND force-releases Busy + hides progress so
 * the UI never gets stuck in a half-broken state.
 */
window.addEventListener("error", e => {
  console.error("[OCTOVOX] uncaught error:", e.error || e.message);
  toast(`⚠ Unexpected error: ${e.message || "unknown"}. UI reset.`, "error");
  Busy.release();
  try { hideProgress(); } catch {}
});
window.addEventListener("unhandledrejection", e => {
  console.error("[OCTOVOX] unhandled rejection:", e.reason);
  const msg = (e.reason && e.reason.message) || String(e.reason || "unknown");
  toast(`⚠ Background task failed: ${msg}. UI reset.`, "error");
  Busy.release();
  try { hideProgress(); } catch {}
});


window.addEventListener("DOMContentLoaded", () => {
  setupHeroTypewriter();
  setupTabs();
  setupDropzone();
  setupSamplePanel();
  setupRecordPanel();
  setupFilesPanel();
  setupProdControls();
  loadDevices();
  loadOutputDevices();
  refreshFiles();
  // App-shell: theme manager + view router + command palette (shell.js).
  // Called last so state + handlers exist before the router activates a view.
  if (window.Shell && window.Shell.afterAppInit) window.Shell.afterAppInit();
});


/* ═══════════════════ HERO TYPEWRITER ═══════════════════ */
function setupHeroTypewriter() {
  const el = $("heroTagText");
  if (!el) return;
  const MSGS = [
    `An <b style="color:var(--teal)">11-stage production pipeline</b> turns 8 raw mic channels into one clean voice — in a fraction of real-time.`,
    `Channel calibration → high-pass → VAD → DOA → <b style="color:var(--teal)">MVDR beamforming</b> → AEC → noise reduction → automix → AGC / EQ / limiter.`,
    `<b style="color:var(--violet)">DeepFilterNet3</b> does the denoising — natural-sounding voice with no robotic, musical-noise artifacts.`,
    `Built for the <b style="color:var(--teal)">sensiBel SB-POLARIS</b> 8-mic optical MEMS array — 48 kHz, 24-bit.`,
  ];
  let idx = 0, char = 0, deleting = false, paused = false, plain = null;
  const plainOf = (h) => { const d = document.createElement("div"); d.innerHTML = h; return d.textContent || ""; };
  function tick() {
    if (paused) return setTimeout(tick, 200);
    const html = MSGS[idx];
    if (plain === null) plain = plainOf(html);
    if (!deleting) {
      char++;
      if (char <= plain.length) { el.textContent = plain.slice(0, char); setTimeout(tick, 28 + Math.random()*22); }
      else { el.innerHTML = html; deleting = true; setTimeout(tick, 3200); }
    } else {
      char--;
      if (char > 0) { el.textContent = plain.slice(0, char); setTimeout(tick, 14); }
      else { deleting = false; idx = (idx + 1) % MSGS.length; plain = null; setTimeout(tick, 350); }
    }
  }
  const tag = qs(".hero-tag");
  if (tag) {
    tag.addEventListener("mouseenter", () => paused = true);
    tag.addEventListener("mouseleave", () => paused = false);
  }
  tick();
}


/* ═══════════════════ THEME-DRIVEN JS COLORS ═══════════════════
 * WaveSurfer + the radar canvas can't read CSS, so they pull their colors
 * from the same design tokens via getComputedStyle. shell.js calls
 * refreshThemedJsColors() whenever the theme flips so both recolor live.
 */
function themeColors() {
  const s = getComputedStyle(document.documentElement);
  const v = n => s.getPropertyValue(n).trim();
  return {
    waveRaw: v("--wave-raw"), waveRawProg: v("--wave-raw-prog"),
    waveClean: v("--wave-clean"), waveCleanProg: v("--wave-clean-prog"), waveCursor: v("--wave-cursor"),
    radarRing: v("--radar-ring"), radarSpoke: v("--radar-spoke"), radarLabel: v("--radar-label"),
    radarHub: v("--radar-hub"), radarBlip: v("--radar-blip"),
    radarTarget: v("--radar-target"), radarHalo: v("--radar-target-halo"),
  };
}
function refreshThemedJsColors() {
  try {
    const c = themeColors();
    if (state.wsInput)  state.wsInput.setOptions({ waveColor: c.waveRaw, progressColor: c.waveRawProg, cursorColor: c.waveCursor });
    if (state.wsWinner) state.wsWinner.setOptions({ waveColor: c.waveClean, progressColor: c.waveCleanProg, cursorColor: c.waveCursor });
  } catch (e) {}
  try { drawAzRadar(state.detectedSpeakers || [], state.targetAz); } catch (e) {}
}


/* ═══════════════════ TABS ═══════════════════ */
function setupTabs() {
  qsa(".tab").forEach(t => {
    t.addEventListener("click", () => {
      qsa(".tab").forEach(x => x.classList.remove("active"));
      qsa(".tab-panel").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      const panel = $("tab" + t.dataset.tab.charAt(0).toUpperCase() + t.dataset.tab.slice(1));
      if (panel) panel.classList.add("active");
    });
  });
}


/* ═══════════════════ RECORD PANEL ═══════════════════ */
async function loadDevices() {
  const sel = $("deviceSelect");
  try {
    const r = await fetch("/api/devices");
    const j = await r.json();
    if (!j.ok) {
      sel.innerHTML = `<option value="">${esc(j.error || "Recording unavailable")}</option>`;
      $("deviceWarn").classList.add("show");
      $("deviceWarn").innerHTML = `⚠ ${esc(j.error || "Cannot enumerate input devices")}`;
      return;
    }
    if (!j.devices.length) {
      sel.innerHTML = `<option value="">No input devices found</option>`;
      return;
    }
    // Sort: Polaris-like (8+ channels) first
    j.devices.sort((a, b) => (b.is_polaris_like - a.is_polaris_like));
    sel.innerHTML = j.devices.map(d => {
      const ok = d.is_polaris_like ? '✓' : '⚠';
      const tag = d.is_polaris_like ? 'Polaris-compatible' : 'only ' + d.max_input_ch + ' ch';
      return `<option value="${d.index}" data-ch="${d.max_input_ch}" data-sr="${d.default_sr}">
        ${ok} #${d.index} · ${esc(d.name)} — ${tag}
      </option>`;
    }).join("");
    // Pick first Polaris-compatible automatically
    const firstPolaris = j.devices.find(d => d.is_polaris_like);
    if (firstPolaris) sel.value = firstPolaris.index;
    validateSelectedDevice();
  } catch (err) {
    sel.innerHTML = `<option value="">Could not load devices</option>`;
    $("deviceWarn").classList.add("show");
    $("deviceWarn").innerHTML = `⚠ ${esc(err.message)}`;
  }
}

function validateSelectedDevice() {
  const sel = $("deviceSelect");
  const opt = sel.options[sel.selectedIndex];
  const warn = $("deviceWarn");
  if (!opt || !opt.dataset.ch) { warn.classList.remove("show"); return; }
  const ch = parseInt(opt.dataset.ch);
  if (ch < REQUIRED_CH) {
    warn.classList.add("show");
    warn.innerHTML = `⚠ <b>This device exposes only ${ch} channels.</b> OCTOVOX needs all ${REQUIRED_CH} channels of your sensiBel SB-POLARIS array. Select a device that exposes 8 inputs.`;
  } else {
    warn.classList.remove("show");
  }
}

function setupRecordPanel() {
  $("refreshDevices").addEventListener("click", loadDevices);
  $("deviceSelect").addEventListener("change", validateSelectedDevice);

  const durSlider = $("recDuration");
  const durLabel = $("recDurationVal");
  const updateDur = () => { durLabel.textContent = durSlider.value + " s"; };
  durSlider.addEventListener("input", updateDur); updateDur();

  $("preflightBtn").addEventListener("click", runPreflight);
  $("recordBtn").addEventListener("click", runRecord);
}

async function runPreflight() {
  if (state.recording) return;
  const device = $("deviceSelect").value;
  const btn = $("preflightBtn");
  btn.disabled = true;
  btn.textContent = "Testing…";
  $("levelsBlock").classList.remove("hidden");
  try {
    const r = await fetch("/api/preflight", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ device, channels: REQUIRED_CH, samplerate: REQUIRED_SR }),
    });
    const j = await r.json();
    if (!j.ok) {
      toast(j.error || "Preflight failed", "error");
      renderLevels([], []);
      return;
    }
    renderLevels(j.per_ch_peak_db, j.per_ch_rms_db, j.warnings || []);
    toast("Preflight done — check channel levels");
  } catch (err) {
    toast("Preflight error: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "⚙ Test mics (0.3 s)";
  }
}

function renderLevels(peakDb, rmsDb, warnings) {
  const bars = $("levelsBars");
  const warnBox = $("levelsWarn");
  if (!peakDb.length) {
    bars.innerHTML = `<div style="grid-column:1/-1;color:var(--muted);text-align:center;padding:12px;">no data</div>`;
    warnBox.innerHTML = "";
    return;
  }
  bars.innerHTML = peakDb.map((p, i) => {
    // Map -60..0 dB to 0..100%
    const pct = Math.max(2, Math.min(100, (p + 60) / 60 * 100));
    const silent = p < -80;
    const clip = p > -1;
    const cls = "level-bar-fill" + (silent ? " silent" : "") + (clip ? " clip" : "");
    return `<div class="level-bar">
      <div class="level-bar-num">ch ${i}</div>
      <div class="level-bar-track"><div class="${cls}" style="height:${pct}%"></div></div>
      <div class="level-bar-val">${p.toFixed(0)} dB</div>
    </div>`;
  }).join("");
  warnBox.innerHTML = (warnings || []).map(w => `<div class="warn-line">⚠ ${esc(w)}</div>`).join("");
}

async function runRecord() {
  if (state.recording) return;
  if (!Busy.acquire("recording")) return;
  state.recording = true;
  const device = $("deviceSelect").value;
  const seconds = parseInt($("recDuration").value);
  const userName = $("recName").value.trim();
  const fname = userName || `rec_${Date.now()}.wav`;
  const btn = $("recordBtn");
  const btnText = $("recordBtnText");
  btn.classList.add("recording");
  btnText.textContent = `● REC · ${seconds}s`;
  let remaining = seconds;
  const tick = setInterval(() => {
    remaining--;
    btnText.textContent = `● REC · ${remaining}s remaining`;
  }, 1000);
  let didProcess = false;
  try {
    const r = await fetch("/api/record", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ device, channels: REQUIRED_CH, samplerate: REQUIRED_SR, seconds, filename: fname }),
    });
    clearInterval(tick);
    if (!r.ok) throw new Error(`HTTP ${r.status} from /api/record`);
    const j = await r.json();
    if (!j.ok) {
      toast("Recording failed: " + (j.error || "unknown error"), "error");
      return;
    }
    // Surface captured signal levels
    if (j.per_ch_peak_db && j.per_ch_rms_db) {
      $("levelsBlock").classList.remove("hidden");
      renderLevels(j.per_ch_peak_db, j.per_ch_rms_db, j.warnings || []);
    }
    // Refuse to analyse silence
    const peakDbfs = j.peak_dbfs ?? -120;
    if (peakDbfs < -70) {
      toast(
        `Recording is silent (peak ${peakDbfs.toFixed(0)} dBFS). The file was saved as "${j.name}" but won't be analysed.\n\n` +
        `Likely causes:\n` +
        `• sensiBel kit not powered or not connected\n` +
        `• Wrong input device selected (your sensiBel shows as "Digital Audio Interface (SB-POL...)")\n` +
        `• Windows input level muted or at 0 in Sound settings\n` +
        `• OS-level mic privacy blocking access`,
        "error");
      refreshFiles();
      return;
    }
    btnText.textContent = `Saved (peak ${peakDbfs.toFixed(0)} dBFS) · analysing…`;
    toast(`Recorded ${j.name} · peak ${peakDbfs.toFixed(0)} dBFS, gain +${(j.gain_applied_db||0).toFixed(0)} dB applied`);
    refreshFiles();
    // Hand off to processFile — release lock first so processFile can re-acquire
    didProcess = true;
    state.recording = false;
    btn.classList.remove("recording");
    btnText.textContent = "Record & analyse";
    Busy.release();
    await processFile(j.name);
  } catch (err) {
    console.error("[runRecord]", err);
    clearInterval(tick);
    toast(`Recording error: ${err.message || "unknown"}`, "error");
  } finally {
    if (!didProcess) {
      state.recording = false;
      btn.classList.remove("recording");
      btnText.textContent = "Record & analyse";
      Busy.release();
    }
  }
}


/* ═══════════════════ DROP ZONE ═══════════════════ */
function setupDropzone() {
  const dz = $("dz");
  const fi = $("fileInput");
  const browse = $("browseBtn");

  const open = () => fi.click();
  dz.addEventListener("click", e => { if (e.target.tagName !== "BUTTON") open(); });
  browse.addEventListener("click", e => { e.stopPropagation(); open(); });
  fi.addEventListener("change", () => {
    if (fi.files.length) handleFile(fi.files[0]);
    fi.value = "";
  });
  ["dragenter","dragover"].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave","drop"].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", e => {
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
}

async function handleFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".wav")) {
    toast(`Please drop a .wav file (got: ${file.name})`, "error");
    return;
  }
  // Client-side size sanity check (server caps at 500 MB)
  if (file.size > 500 * 1024 * 1024) {
    toast(`File too large (${(file.size/1024/1024).toFixed(0)} MB). Maximum is 500 MB.`, "error");
    return;
  }

  // Acquire the global lock — refuse if anything else is running.
  if (!Busy.acquire(`uploading ${file.name}`)) return;

  // Inner uploader so we can reuse it for "Replace" and "Save with new name"
  const doUpload = async (uploadFile, opts = {}) => {
    showProgress(`Uploading ${uploadFile.name}…`);
    const fd = new FormData();
    fd.append("file", uploadFile, uploadFile.name);
    if (opts.overwrite) fd.append("overwrite", "1");
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    if (!r.ok && r.status !== 400) {
      throw new Error(`Server returned HTTP ${r.status}`);
    }
    return r.json();
  };

  let triggerProcess = true;   // set false on "Keep existing" or any error
  try {
    let j = await doUpload(file);

    // ── Duplicate handling — friendly modal with 3 choices ──────
    if (!j.ok && j.duplicate) {
      hideProgress();
      const sizeMb = (j.existing_size_kb / 1024).toFixed(1);
      const dur    = (j.existing_duration || 0).toFixed(1);
      const choice = await showModal({
        icon: "📁",
        iconType: "warn",
        title: "A file with this name already exists",
        body: `
          <p>You already have <code>${esc(j.name)}</code> in your input folder.
             What would you like to do?</p>
          <div class="modal-info">
            <div class="mi-row"><span>Existing file size</span><b>${sizeMb} MB</b></div>
            <div class="mi-row"><span>Existing duration</span><b>${dur} s</b></div>
          </div>
          <p style="font-size:12px;color:var(--muted);">
             💡 Tip — saving as <code>${esc(j.suggested_name)}</code> keeps both files so you can compare results.
          </p>`,
        buttons: [
          { id: "cancel",  label: "Keep existing",      variant: "ghost"   },
          { id: "replace", label: "Replace",             variant: "danger"  },
          { id: "rename",  label: `Save as ${j.suggested_name}`, variant: "primary" },
        ],
      });

      if (choice === "cancel") {
        // Helpful "kept existing" flow — release lock first, then guide
        triggerProcess = false;
        Busy.release();           // release BEFORE refreshing so file row is interactive
        await refreshFiles();     // wait for the row to actually exist
        if (window.Shell) window.Shell.router.navigate("library");
        const row = document.querySelector(`.file-row[data-name="${cssEscape(j.name)}"]`);
        if (row) {
          row.classList.add("flash-highlight");
          setTimeout(() => row.classList.remove("flash-highlight"), 2400);
          const hasResult = row.classList.contains("has-result");
          toast(hasResult
            ? `✓ Kept ${j.name}. Click ◉ to view its existing results.`
            : `✓ Kept ${j.name}. Click ▶ to analyse it.`);
        } else {
          toast(`✓ Kept ${j.name} — your original file is safe.`);
        }
        return;
      }
      if (choice === "replace") {
        j = await doUpload(file, { overwrite: true });
      } else if (choice === "rename") {
        const renamed = new File([file], j.suggested_name, { type: file.type });
        j = await doUpload(renamed);
      }
    }

    // ── Spec mismatch or other backend rejection ────────────────
    if (!j.ok) {
      triggerProcess = false;
      hideProgress();
      if (j.problems && j.problems.length) {
        const details = j.problems.map(p => `• ${p}`).join("\n");
        toast(`File rejected (doesn't match sensiBel spec):\n${details}`, "error");
      } else {
        toast(`Upload failed: ${j.error || "unknown error"}`, "error");
      }
      return;
    }

    // ── Success: surface warnings, refresh files, then analyse ──
    const fname = j.name;
    if ((j.warnings || []).length) {
      j.warnings.forEach(w => toast(`⚠ ${w}`, "warn"));
    }
    toast(j.replaced ? `Replaced ${fname} ✓` : `Uploaded ${fname} ✓`);
    refreshFiles();

    // Hand off the busy state to processFile — it will release on its own.
    triggerProcess = false;
    Busy.release();
    await processFile(fname);
  } catch (err) {
    console.error("[handleFile]", err);
    hideProgress();
    toast(`Upload failed: ${err.message || "unknown error"}`, "error");
  } finally {
    // Belt-and-suspenders: if we still hold the upload lock (didn't hand off
    // to processFile and didn't manually release), free it now.
    if (Busy.isBusy() && Busy.what && Busy.what.startsWith("uploading")) {
      Busy.release();
    }
  }
}

// CSS attribute selector escape helper (filenames may contain spaces, parens, etc.)
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, "\\$&");
}


/* ═══════════════════ SAMPLE PANEL ═══════════════════ */
function setupSamplePanel() {
  const snr = $("sampleSnr"), snrLab = $("sampleSnrVal");
  const dur = $("sampleDur"), durLab = $("sampleDurVal");
  const updateSnr = () => { snrLab.textContent = (snr.value >= 0 ? "+" : "") + snr.value + " dB"; };
  const updateDur = () => { durLab.textContent = dur.value + " s"; };
  snr.addEventListener("input", updateSnr); updateSnr();
  dur.addEventListener("input", updateDur); updateDur();

  $("sampleBtn").addEventListener("click", async () => {
    if (!Busy.acquire("generating sample")) return;
    let handedOff = false;
    try {
      showProgress("Generating synthetic 8-channel sample…");
      const r = await fetch("/api/sample", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ duration_s: parseInt(dur.value), snr_db: parseInt(snr.value) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} from /api/sample`);
      const j = await r.json();
      const fname = j.filename || j.name;
      if (fname) {
        toast(`Sample generated: ${fname} · analysing…`);
        handedOff = true;
        Busy.release();           // release first so processFile can re-acquire
        await processFile(fname);
      } else {
        hideProgress();
        toast(`Sample failed: ${j.error || "unknown"}`, "error");
      }
    } catch (err) {
      console.error("[sampleBtn]", err);
      hideProgress();
      toast(`Sample failed: ${err.message || "unknown"}`, "error");
    } finally {
      if (!handedOff) Busy.release();
    }
  });
}


/* ═══════════════════ PROCESS STREAM ═══════════════════ */
/**
 * Per-file primary action. The app's running pipeline is now the production
 * voice chain (POST /api/clean → prod_pipeline.run_production), so "analyse"
 * cleans the voice and shows the stages + timing. Kept named ``processFile``
 * because every caller (row ▶, Run-all, post-upload auto-run) invokes it.
 */
async function processFile(filename) {
  return runProduction(filename);
}

function showProgress(msg) {
  $("progressBlock").classList.remove("hidden");
  $("progressTitle").textContent = msg;
  $("progressPct").textContent = "0%";
  $("progressFill").style.width = "0%";
  $("progressLog").innerHTML = "";
  qsa(".ps").forEach(s => s.classList.remove("active", "done"));
  $("progressBlock").scrollIntoView({ behavior: "smooth", block: "center" });

  // Show sticky mini-bar with same title
  const sp = $("stickyProgress");
  if (sp) {
    $("spTitle").textContent = msg;
    $("spSub").textContent = "starting…";
    $("spPct").textContent = "0%";
    $("spFill").style.width = "0%";
    sp.classList.remove("hidden");
    // Click → scroll to full progress panel
    sp.onclick = () => $("progressBlock").scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function updateProgress(msg, pct) {
  $("progressTitle").textContent = msg || "Working…";
  if (pct != null && pct >= 0) {
    const p = Math.max(0, Math.min(100, pct));
    $("progressPct").textContent = `${Math.round(p)}%`;
    $("progressFill").style.width = `${p}%`;
    // Mirror into sticky
    $("spPct") && ($("spPct").textContent = `${Math.round(p)}%`);
    $("spFill") && ($("spFill").style.width = `${p}%`);
  }
  // Sticky sub-line — the in-flight stage message (different from title)
  $("spSub") && ($("spSub").textContent = msg || "working…");
  let activeStage = null;
  for (const [stage, keys] of Object.entries(STAGE_KEYWORDS)) {
    if (keys.some(k => (msg || "").toLowerCase().includes(k.toLowerCase()))) {
      activeStage = stage; break;
    }
  }
  if (activeStage) {
    let foundActive = false;
    qsa(".ps").forEach(s => {
      const st = s.dataset.stage;
      if (st === activeStage) { s.classList.remove("done"); s.classList.add("active"); foundActive = true; }
      else if (!foundActive)  { s.classList.remove("active"); s.classList.add("done"); }
      else                    { s.classList.remove("active", "done"); }
    });
  }
  const log = $("progressLog");
  qsa(".progress-log .line").forEach(l => l.classList.remove("fresh"));
  const line = document.createElement("div");
  line.className = "line fresh";
  const t = new Date().toLocaleTimeString();
  line.textContent = `${t}  ${msg}`;
  log.prepend(line);
  while (log.children.length > 20) log.lastChild.remove();
}

function hideProgress() {
  $("progressBlock").classList.add("hidden");
  const sp = $("stickyProgress");
  if (sp) sp.classList.add("hidden");
}


/* ═══════════════════ FILES PANEL ═══════════════════ */
function setupFilesPanel() {
  $("refreshFiles").addEventListener("click", refreshFiles);
  $("runAllBtn").addEventListener("click", runAllFiles);
  $("clearOutputBtn").addEventListener("click", clearAllOutput);

  // ── Restore persisted sort preference (density was removed) ─────
  try {
    state.fileSortMode = localStorage.getItem("octovox.fileSort") || "newest";
    state.fileFilterQ  = "";  // search is always empty on fresh load
  } catch { /* localStorage may be blocked in private mode */ }

  // ── Sort dropdown ────────────────────────────────────────────
  const sortSel = $("filesSort");
  if (sortSel) {
    sortSel.value = state.fileSortMode || "newest";
    sortSel.addEventListener("change", () => {
      state.fileSortMode = sortSel.value;
      try { localStorage.setItem("octovox.fileSort", state.fileSortMode); } catch {}
      rerenderFiles();
    });
  }

  // ── Filter input (live, debounced) ────────────────────────────
  const filt    = $("filesFilter");
  const clearBt = $("filesFilterClear");
  let debounceT = null;
  if (filt) {
    filt.addEventListener("input", () => {
      clearBt && clearBt.classList.toggle("hidden", !filt.value);
      clearTimeout(debounceT);
      debounceT = setTimeout(() => {
        state.fileFilterQ = filt.value;
        rerenderFiles();
      }, 80);
    });
  }
  if (clearBt) {
    clearBt.addEventListener("click", () => {
      filt.value = "";
      state.fileFilterQ = "";
      clearBt.classList.add("hidden");
      rerenderFiles();
      filt.focus();
    });
  }
}

/* Re-render the visible list using cached state (no network call). */
function rerenderFiles() {
  if (!state.filesAll) return;
  renderFilesList(state.filesAll, state.filesWMap || {});
}

async function refreshFiles() {
  try {
    const [filesR, verdictR] = await Promise.all([
      fetch("/api/list_input"), fetch("/api/verdict"),
    ]);
    const filesJ = await filesR.json();
    const vJ = await verdictR.json();
    const wMap = {};
    (vJ.recordings || []).forEach(r => wMap[r.stem] = r);
    renderFilesList(filesJ.files || [], wMap);
    populateReferencePicker(filesJ.files || []);   // keep AEC ref picker in sync
  } catch (err) { console.warn("refreshFiles failed:", err); }
}

function renderFilesList(files, wMap) {
  const list    = $("filesList");
  const empty   = $("filesEmpty");
  const toolbar = $("filesToolbar");
  const countEl = $("filesCount");
  if (!files || !files.length) {
    list.innerHTML = ""; empty.style.display = "";
    if (toolbar) toolbar.style.display = "none";
    return;
  }
  empty.style.display = "none";
  if (toolbar) toolbar.style.display = "";

  // Save the raw list so the sort/filter bar can re-render
  // without another network round-trip.
  state.filesAll = files.slice();
  state.filesWMap = wMap || {};

  const visible = applyFileSortFilter(files, state.filesWMap);
  if (countEl) {
    countEl.textContent = (visible.length === files.length)
      ? `${files.length} file${files.length === 1 ? "" : "s"}`
      : `${visible.length} of ${files.length}`;
  }
  if (!visible.length) {
    list.innerHTML = `<div class="files-no-match">No files match this filter.</div>`;
    return;
  }

  list.innerHTML = visible.map((f, idx) => {
    const stem = f.name.replace(/\.wav$/i, "");
    const winner = wMap[stem];
    const hasResult = !!winner;
    const isNMW = hasResult && winner.winner === "Neural-MVDR-WPE";

    // status drives the left border colour
    let statusCls = "status-fresh";
    if (hasResult) statusCls = isNMW ? "status-gold" : "status-analysed";

    const winnerHtml = hasResult
      ? `<div class="file-winner-pill" title="Bootstrap winner: ${esc(winner.winner)} (${winner.confidence.toFixed(0)}%)">★ ${esc(winner.winner)}</div>`
      : `<div class="file-winner-pill file-winner-pill-empty">not analysed</div>`;

    return `
      <div class="file-row ${statusCls}" data-name="${esc(f.name)}" data-idx="${idx}" tabindex="-1">
        <div class="file-num">${idx + 1}</div>
        <div class="file-icon">WAV</div>
        <div class="file-name" contenteditable="false" data-stem="${esc(stem)}">${esc(f.name)}</div>
        ${winnerHtml}
        <button class="file-btn file-btn-go" title="${hasResult ? 'View results' : 'Analyse'}" data-action="analyse">${hasResult ? '◉' : '▶'}</button>
        <button class="file-btn" title="Rename" data-action="rename">✎</button>
        <button class="file-btn file-btn-del" title="Delete" data-action="delete">✕</button>
      </div>`;
  }).join("");

  // Re-bind row event handlers (one per row)
  qsa(".file-row").forEach(row => {
    const fname = row.dataset.name;
    const stem = row.querySelector(".file-name").dataset.stem;

    row.querySelector('[data-action="analyse"]').addEventListener("click", async e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      state.selectedFile = fname;
      if (state.filesWMap[stem]) { await showResults(stem); return; }
      btn.setAttribute("data-state", "running");
      const origText = btn.textContent;
      btn.textContent = "⟳";
      try {
        await processFile(fname);
      } finally {
        btn.removeAttribute("data-state");
        btn.textContent = origText;
      }
    });

    row.querySelector('[data-action="rename"]').addEventListener("click", e => {
      e.stopPropagation();
      const nameEl = row.querySelector(".file-name");
      const orig = nameEl.textContent;
      nameEl.contentEditable = "true";
      nameEl.focus();
      const range = document.createRange();
      const sel = window.getSelection();
      const text = nameEl.firstChild;
      if (text) {
        const dot = orig.lastIndexOf(".");
        range.setStart(text, 0);
        range.setEnd(text, dot >= 0 ? dot : orig.length);
        sel.removeAllRanges(); sel.addRange(range);
      }
      const finish = async (commit) => {
        nameEl.contentEditable = "false";
        nameEl.removeEventListener("blur", onBlur);
        nameEl.removeEventListener("keydown", onKey);
        const newName = nameEl.textContent.trim();
        if (!commit || newName === orig || !newName) { nameEl.textContent = orig; return; }
        try {
          const r = await fetch("/api/rename", {
            method: "POST", headers: {"Content-Type":"application/json"},
            body: JSON.stringify({ from: orig, to: newName }),
          });
          const j = await r.json();
          if (j.ok) { toast(`Renamed to ${j.new}`); refreshFiles(); loadVerdict(); }
          else { toast("Rename failed: " + (j.error || "?"), "error"); nameEl.textContent = orig; }
        } catch (err) {
          toast("Rename failed: " + err.message, "error"); nameEl.textContent = orig;
        }
      };
      const onBlur = () => finish(true);
      const onKey = (e) => {
        if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      };
      nameEl.addEventListener("blur", onBlur);
      nameEl.addEventListener("keydown", onKey);
    });

    row.querySelector('[data-action="delete"]').addEventListener("click", async e => {
      e.stopPropagation();
      const choice = await showModal({
        icon: "🗑",
        iconType: "danger",
        title: "Delete this recording?",
        body: `
          <p>You're about to permanently delete <code>${esc(fname)}</code>.</p>
          <div class="modal-info">
            <div class="mi-row"><span>The .wav file</span><b style="color:var(--rose);">will be removed</b></div>
            <div class="mi-row"><span>Its analysis results</span><b style="color:var(--rose);">will be removed</b></div>
            <div class="mi-row"><span>Best-algorithm verdict</span><b>will refresh</b></div>
          </div>
          <p style="font-size:12px;color:var(--muted);">This can't be undone.</p>`,
        buttons: [
          { id: "cancel", label: "Keep it",  variant: "ghost"  },
          { id: "delete", label: "Delete",   variant: "danger" },
        ],
      });
      if (choice !== "delete") return;
      try {
        const r = await fetch("/api/delete", {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ filename: fname }),
        });
        const j = await r.json();
        if (j.ok) {
          if (state.currentStem === stem) {
            state.currentStem = null;
            state.currentMetrics = null;
            if (state.wsInput)  { try { state.wsInput.destroy(); } catch{} state.wsInput = null; }
            if (state.wsWinner) { try { state.wsWinner.destroy(); } catch{} state.wsWinner = null; }
            if (window.Shell) {
              window.Shell.router.refreshGate();
              if (window.Shell.router.current === "studio") window.Shell.router.navigate("library");
            }
          }
          toast(`Deleted ${fname} ✓`);
          refreshFiles();
          loadVerdict();
        } else {
          toast("Delete failed: " + (j.error || "?"), "error");
        }
      } catch (err) { toast("Delete failed: " + err.message, "error"); }
    });
  });
}

/* Default sort+filter used until patch 2's bar is wired in. */
function applyFileSortFilter(files, wMap) {
  const sortMode = (state.fileSortMode || "newest");
  const query    = (state.fileFilterQ  || "").trim().toLowerCase();
  let arr = files.slice();
  if (query) arr = arr.filter(f => (f.name || "").toLowerCase().includes(query));
  if (sortMode === "newest")
    arr.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  else if (sortMode === "oldest")
    arr.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
  else if (sortMode === "name")
    arr.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (sortMode === "winrate") {
    arr.sort((a, b) => {
      const stemA = (a.name || "").replace(/\.wav$/i, "");
      const stemB = (b.name || "").replace(/\.wav$/i, "");
      const cA = (wMap[stemA] && wMap[stemA].confidence) || -1;
      const cB = (wMap[stemB] && wMap[stemB].confidence) || -1;
      return cB - cA;
    });
  }
  return arr;
}



/* ═══════════════════ BATCH: RUN ALL ═══════════════════
 * Analyse every input file that hasn't been processed yet, one after
 * another. The pipeline is single-threaded (Busy enforces one op at a
 * time), so we drive processFile() sequentially — each call acquires and
 * releases the global lock on its own. Already-analysed files are skipped.
 */
async function runAllFiles() {
  if (state.runningAll) return;
  if (Busy.isBusy()) {
    toast(`⏳ Wait — ${Busy.what} is still running. Try Run all when it finishes.`, "warn");
    return;
  }

  // Operate on the current set of files + which already have results.
  await refreshFiles();
  const all = (state.filesAll || []).slice();
  if (!all.length) {
    toast("No files to analyse — record, upload, or generate a sample first.", "warn");
    return;
  }
  const wMap = state.filesWMap || {};
  const pending = all.filter(f => !wMap[f.name.replace(/\.wav$/i, "")]);
  if (!pending.length) {
    toast("All files are already analysed ✓ — use Clear output first to re-run them.");
    return;
  }

  // Target-speaker extraction is a single-file, interactive choice; a batch run
  // must not apply one file's azimuth to every recording. Drop it up front so
  // the result is order-independent.
  state.targetAz = null;
  state.interfererAz = null;
  state.detectedSpeakers = [];
  state.speakersFile = null;
  renderSpeakerChips([]);

  state.runningAll = true;
  const btn = $("runAllBtn");
  const origText = btn.textContent;
  btn.disabled = true;
  let ok = 0, fail = 0;
  try {
    for (let i = 0; i < pending.length; i++) {
      const f = pending[i];
      btn.textContent = `Running ${i + 1}/${pending.length}…`;
      toast(`▶ Analysing ${f.name} (${i + 1}/${pending.length})`);
      const success = await processFile(f.name);
      if (success) ok++; else fail++;
    }
    toast(fail
      ? `Run all finished — ${ok} analysed, ${fail} failed. Check the server terminal.`
      : `Run all finished — analysed ${ok} file${ok === 1 ? "" : "s"} ✓`,
      fail ? "warn" : undefined);
  } finally {
    state.runningAll = false;
    btn.disabled = false;
    btn.textContent = origText;
    refreshFiles();
    loadVerdict();
  }
}


/* ═══════════════════ BATCH: CLEAR OUTPUT ═══════════════════
 * Wipe every previous analysis result (/output/<stem> folders). Input
 * .wav files are kept. Confirms first, then resets the open results view
 * and the verdict.
 */
async function clearAllOutput() {
  if (state.runningAll) {
    toast("⏳ Wait — Run all is still in progress.", "warn");
    return;
  }
  if (Busy.isBusy()) {
    toast(`⏳ Wait — ${Busy.what} is still running.`, "warn");
    return;
  }

  const choice = await showModal({
    icon: "🗑",
    iconType: "danger",
    title: "Clear all previous output?",
    body: `
      <p>This permanently removes <b>every analysis result</b> — winner audio,
         visualizations, reports and metrics for all recordings.</p>
      <div class="modal-info">
        <div class="mi-row"><span>Your input .wav files</span><b>will be kept</b></div>
        <div class="mi-row"><span>All analysis results</span><b style="color:var(--rose);">will be removed</b></div>
        <div class="mi-row"><span>Best-algorithm verdict</span><b>will reset</b></div>
      </div>
      <p style="font-size:12px;color:var(--muted);">You can re-analyse any file afterwards. This can't be undone.</p>`,
    buttons: [
      { id: "cancel", label: "Keep results", variant: "ghost"  },
      { id: "clear",  label: "Clear output", variant: "danger" },
    ],
  });
  if (choice !== "clear") return;

  try {
    const r = await fetch("/api/clear_output", { method: "POST" });
    const j = await r.json();
    if (!j.ok) { toast("Clear failed: " + (j.error || "?"), "error"); return; }

    // Reset any currently-open results view.
    state.currentStem = null;
    state.currentMetrics = null;
    if (state.wsInput)  { try { state.wsInput.destroy(); }  catch {} state.wsInput = null; }
    if (state.wsWinner) { try { state.wsWinner.destroy(); } catch {} state.wsWinner = null; }
    if (window.Shell) {
      window.Shell.router.refreshGate();
      if (window.Shell.router.current === "studio") window.Shell.router.navigate("library");
    }

    toast(`Cleared ${j.removed} result${j.removed === 1 ? "" : "s"} ✓`);
    refreshFiles();
    loadVerdict();
  } catch (err) {
    toast("Clear failed: " + err.message, "error");
  }
}


/* ═══════════════════ RESULTS (production) ═══════════════════ */


/* ── Speaker detection ────────────────────────────────────────────────────── */

/** Smallest absolute angular separation (degrees) between two azimuths, correct
 *  across the ±180° wrap. JS `%` can return negatives, so normalise to [0,360)
 *  before folding to [-180,180) — otherwise boundary pairs (e.g. -180 vs 175,
 *  which the UCA's front/back ambiguity produces) read as ~355° instead of 5°. */
function azSep(a, b) {
  const d = (((a - b + 180) % 360) + 360) % 360 - 180;
  return Math.abs(d);
}

/** Call /api/speakers on the current file and populate the speaker chips. */
async function detectSpeakers(filename) {
  if (!filename) { toast("Select or clean a file first, then detect speakers.", "warn"); return; }
  const btn = $("detectSpeakersBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⌛…"; }
  try {
    const r = await fetch("/api/speakers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "speaker detect failed");
    state.detectedSpeakers = j.speakers || [];
    state.speakersFile = filename;
    renderSpeakerChips(state.detectedSpeakers);   // also redraws the radar
    const n = state.detectedSpeakers.length;
    toast(n > 0
      ? `Found ${n} talker direction${n > 1 ? "s" : ""} — pick one below to extract it.`
      : "No distinct speaker directions found (may be single-speaker or reverberant).",
      n > 0 ? "ok" : "warn");
  } catch (err) {
    toast(`Speaker detect failed: ${err.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⊕ Detect"; }
  }
}

/** Render speaker direction chips from a speakers array. The radar is always
 *  shown (it doubles as a click-to-aim control), so this only fills the chip
 *  strip + keeps the readout / clear button in sync. */
function renderSpeakerChips(speakers) {
  const wrap = $("speakerChips");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!speakers || speakers.length === 0) {
    wrap.innerHTML = '<span class="speaker-empty">⊕ Detect to list talkers, or click the radar to aim.</span>';
  } else {
    speakers.forEach(sp => {
      const az = Math.round(sp.az);
      const strength = Math.round((sp.strength || 0) * 100);
      const activity = Math.round((sp.activity || 0) * 100);
      const isActive = state.targetAz != null && azSep(sp.az, state.targetAz) < 1.0;
      const chip = document.createElement("button");
      chip.className = "speaker-chip" + (isActive ? " active" : "");
      chip.dataset.az = sp.az;
      chip.title = `Azimuth ${az > 0 ? "+" : ""}${az}° · strength ${strength}% · activity ${activity}%`;
      chip.innerHTML =
        `<span class="sc-dir">${az > 0 ? "+" : ""}${az}°</span>` +
        `<span class="sc-bar"><span class="sc-fill" style="width:${strength}%"></span></span>`;
      chip.addEventListener("click", () => {
        if (isActive) clearSpeakerSelection();
        else selectSpeaker(sp.az, speakers);
      });
      wrap.appendChild(chip);
    });
  }
  drawAzRadar(speakers, state.targetAz);
  updateTargetReadout();
  const clearBtn = $("clearSpeakerBtn");
  if (clearBtn) clearBtn.classList.toggle("hidden", state.targetAz == null);
}

/** Mark one detected azimuth as the extraction target; the others become
 *  interferers. */
function selectSpeaker(az, speakers) {
  state.targetAz = Math.round(az);
  state.interfererAz = (speakers || state.detectedSpeakers)
    .map(s => s.az)
    .filter(a => azSep(a, az) >= 20);
  renderSpeakerChips(state.detectedSpeakers);
  const label = `${az > 0 ? "+" : ""}${Math.round(az)}°`;
  toast(`Will extract speaker at ${label} on next run — click ↻ Re-run or analyse a file.`, "ok");
}

/** Aim at an ARBITRARY azimuth (radar click) — not necessarily a detected
 *  talker. Interferers come from any detected directions ≥20° away; if none
 *  were detected, the pipeline auto-detects them at run time. */
function setManualTarget(az) {
  az = Math.round((((az + 180) % 360 + 360) % 360) - 180);   // → [-180,180)
  state.targetAz = az;
  const others = (state.detectedSpeakers || []).map(s => s.az).filter(a => azSep(a, az) >= 20);
  state.interfererAz = others.length ? others : null;
  renderSpeakerChips(state.detectedSpeakers);
  toast(`Aimed at ${az > 0 ? "+" : ""}${az}° — re-run to extract that direction.`, "ok");
}

/** Remove the speaker filter — next run will process all voices. */
function clearSpeakerSelection() {
  state.targetAz = null;
  state.interfererAz = null;
  renderSpeakerChips(state.detectedSpeakers);
  toast("Speaker filter cleared — all voices will be processed.", "ok");
}

/** Map a click on the radar canvas to an azimuth in [-180,180), or null if the
 *  click is too near the centre (ambiguous). Accounts for CSS scaling. */
function radarClickToAz(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (canvas.width / rect.width);
  const y = (evt.clientY - rect.top) * (canvas.height / rect.height);
  const dx = x - canvas.width / 2, dy = y - canvas.height / 2;
  if (Math.hypot(dx, dy) < 8) return null;
  // inverse of drawAzRadar: screen angle = (az - 90)°
  const az = Math.atan2(dy, dx) * 180 / Math.PI + 90;
  return Math.round((((az + 180) % 360 + 360) % 360) - 180);
}

/** Update the small "target NN°" / "all voices" readout under the radar. */
function updateTargetReadout() {
  const el = $("targetReadout");
  if (!el) return;
  if (state.targetAz == null) {
    el.textContent = "all voices · ⊕ Detect, or click the radar to aim";
    el.classList.remove("armed");
  } else {
    const a = state.targetAz;
    el.textContent = `🎯 target ${a > 0 ? "+" : ""}${a}°` +
      (state.interfererAz && state.interfererAz.length
        ? ` · nulling ${state.interfererAz.map(v => (v > 0 ? "+" : "") + Math.round(v) + "°").join(", ")}`
        : "");
    el.classList.add("armed");
  }
}

/** Drop the speaker selection + chips when we move to a different file — a
 *  target azimuth detected on one recording is meaningless for another. */
function resetSpeakersForFile(filename) {
  if (state.speakersFile === filename) return;   // same file → keep the picker
  state.targetAz = null;
  state.interfererAz = null;
  state.detectedSpeakers = [];
  state.speakersFile = null;
  renderSpeakerChips([]);
}

/** Draw a top-down azimuth radar on the <canvas> showing detected speakers. */
function drawAzRadar(speakers, targetAz) {
  const canvas = $("azRadar");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const tc = themeColors();
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(cx, cy) - 10;
  ctx.clearRect(0, 0, W, H);
  // Background circle + grid
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.strokeStyle = tc.radarRing; ctx.lineWidth = 1; ctx.stroke();
  for (let deg = 0; deg < 360; deg += 45) {
    const rad = (deg - 90) * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(rad), cy + R * Math.sin(rad));
    ctx.strokeStyle = tc.radarSpoke; ctx.lineWidth = 1; ctx.stroke();
  }
  // "F" label (front, 0°)
  ctx.fillStyle = tc.radarLabel; ctx.font = "9px JetBrains Mono, monospace";
  ctx.textAlign = "center"; ctx.fillText("F", cx, cy - R - 3);
  // Center dot (mic array)
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
  ctx.fillStyle = tc.radarHub; ctx.fill();
  // Draw each detected speaker
  let targetMatched = false;
  (speakers || []).forEach(sp => {
    const isTarget = targetAz != null && azSep(sp.az, targetAz) < 1.0;
    if (isTarget) targetMatched = true;
    const rad = (sp.az - 90) * Math.PI / 180;
    const r = R * (0.55 + 0.35 * (sp.strength || 0.5));
    const x = cx + r * Math.cos(rad), y = cy + r * Math.sin(rad);
    // Line from center
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y);
    ctx.strokeStyle = isTarget ? tc.radarTarget : tc.radarHub;
    ctx.lineWidth = isTarget ? 2 : 1; ctx.stroke();
    // Dot
    ctx.beginPath(); ctx.arc(x, y, isTarget ? 6 : 4, 0, 2 * Math.PI);
    ctx.fillStyle = isTarget ? tc.radarTarget : tc.radarBlip; ctx.fill();
    if (isTarget) {
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 2 * Math.PI);
      ctx.strokeStyle = tc.radarHalo; ctx.lineWidth = 2; ctx.stroke();
    }
  });
  // Manual aim that isn't one of the detected talkers → draw its own marker so
  // a radar-click target is always visible.
  if (targetAz != null && !targetMatched) {
    const rad = (targetAz - 90) * Math.PI / 180;
    const x = cx + R * 0.85 * Math.cos(rad), y = cy + R * 0.85 * Math.sin(rad);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y);
    ctx.strokeStyle = tc.radarTarget; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = tc.radarTarget; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 9, 0, 2 * Math.PI);
    ctx.strokeStyle = tc.radarHalo; ctx.lineWidth = 2; ctx.stroke();
  }
  // Hint when nothing is aimed/detected.
  if ((!speakers || !speakers.length) && targetAz == null) {
    ctx.fillStyle = tc.radarLabel; ctx.font = "8px JetBrains Mono, monospace";
    ctx.textAlign = "center"; ctx.fillText("click to aim", cx, cy + R + 9);
  }
}


/* Preset → knob values. "quality" = the full-quality defaults (unchanged
 * output); "fast" = the low-runtime profile (no neural NR, single-beam coherent
 * mask, lighter residual). "custom" leaves whatever the user set. */
const PROD_PRESETS = {
  // quality: full DFN3 + the never-worse "auto" mask (output unchanged).
  // fast: no neural NR, single-beam coherent mask, and beam="batch" so the
  // movement detectors (rtf_drift + tracking-path conditioning) are skipped
  // entirely — a documented tradeoff (won't follow a fast-moving talker) for
  // the lowest runtime (~0.33× real-time here vs ~0.44× for quality).
  quality: { nr: "dfn",  beam: "auto",  mask: "auto",     residual: 0.6,  dereverb: "none" },
  fast:    { nr: "fast", beam: "batch", mask: "coherent", residual: 0.45, dereverb: "none" },
};

/** Apply a named preset to the individual control elements (guarded — a missing
 *  control is simply skipped). Does nothing for "custom". */
function applyProdPreset(name) {
  const p = PROD_PRESETS[name];
  if (!p) return;
  const set = (id, val) => { const el = $(id); if (el != null && val != null) el.value = String(val); };
  set("prodNr", p.nr);
  set("prodBeam", p.beam);
  set("prodMask", p.mask);
  set("prodDereverb", p.dereverb);
  const r = $("prodResidual");
  if (r && p.residual != null) { r.value = String(p.residual); r.dispatchEvent(new Event("input")); }
}

/** Wire live readouts + the preset selector for the pipeline control knobs. */
function setupProdControls() {
  const r = $("prodResidual"), rv = $("prodResidualVal");
  if (r && rv) {
    const show = () => {
      const v = parseFloat(r.value);
      const tag = v <= 0 ? " (off)" : v < 0.45 ? " (gentle)" : v < 0.8 ? " (natural)" : " (aggressive)";
      rv.textContent = v.toFixed(2) + tag;
    };
    r.addEventListener("input", show);
    show();
  }
  // Advanced-knob live readouts (slider value → label).
  const liveLabel = (id, valId, fmt) => {
    const el = $(id), lab = $(valId);
    if (!el || !lab) return;
    const show = () => { lab.textContent = fmt(parseFloat(el.value)); };
    el.addEventListener("input", show); show();
  };
  liveLabel("prodBlend", "prodBlendVal", v => v.toFixed(2));
  liveLabel("prodDfnCap", "prodDfnCapVal", v => `${v} dB`);
  liveLabel("prodPauseFloor", "prodPauseFloorVal", v => `−${Math.abs(v)} dB`);

  // Preset dropdown drives the individual knobs; touching any knob flips the
  // preset back to "custom" so the label never lies about the live settings.
  const preset = $("prodPreset");
  if (preset) {
    preset.addEventListener("change", () => applyProdPreset(preset.value));
    ["prodNr", "prodBeam", "prodMask", "prodDereverb", "prodResidual",
     "prodBlend", "prodDfnCap", "prodPauseFloor"].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener("change", () => {
        if (preset.value !== "custom") preset.value = "custom";
      });
    });
  }
  populateReferencePicker();
  // Speaker detection + clear buttons
  const detectBtn = $("detectSpeakersBtn");
  if (detectBtn) detectBtn.addEventListener("click", () => {
    const fname = state.selectedFile || (state.currentStem ? `${state.currentStem}.wav` : null);
    detectSpeakers(fname);
  });
  const clearSpBtn = $("clearSpeakerBtn");
  if (clearSpBtn) clearSpBtn.addEventListener("click", () => clearSpeakerSelection());
  // Radar is a click-to-aim control: click any direction to steer the beam there
  // (snapping to a nearby detected talker if one is within 8°).
  const radar = $("azRadar");
  if (radar) {
    radar.addEventListener("click", (e) => {
      const az = radarClickToAz(radar, e);
      if (az == null) return;
      const near = (state.detectedSpeakers || []).find(s => azSep(s.az, az) < 8);
      if (near) selectSpeaker(near.az, state.detectedSpeakers);
      else setManualTarget(az);
    });
    drawAzRadar(state.detectedSpeakers, state.targetAz);   // initial empty radar
    updateTargetReadout();
  }
}

/** Fill the AEC reference dropdown from the input file list, preserving the
 *  current choice. Pass the already-fetched file list to avoid a second call;
 *  otherwise it fetches. Called on init and whenever the file list changes. */
async function populateReferencePicker(fileList) {
  const sel = $("prodReference");
  if (!sel) return;
  const keep = sel.value;
  try {
    let files = fileList;
    if (!files) {
      const j = await (await fetch("/api/list_input")).json();
      files = j.files || [];
    }
    const names = files.map(f => f.name);
    sel.innerHTML = `<option value="">None (AEC off)</option>` +
      names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    if (keep && names.includes(keep)) sel.value = keep;
  } catch { /* leave the existing options on a fetch failure */ }
}

/** Read the current pipeline control knobs from the results panel. */
function getProdOpts() {
  const opts = {
    nr:   ($("prodNr")   || {}).value || "fast",
    beam: ($("prodBeam") || {}).value || "auto",
    agc:  ($("prodAgc")  || {}).value || "perceptual",
    aec:  ($("prodAec")  || {}).value || "partitioned",
    movement: ($("prodMovement") || {}).value || "srp",
    mask: ($("prodMask") || {}).value || "snr",
    track: ($("prodTrack") ? ($("prodTrack").checked ? "conditioned" : "audio") : "conditioned"),
    dereverb: ($("prodDereverb") || {}).value || "none",
    residual: ($("prodResidual") ? parseFloat($("prodResidual").value) : 0.6),
    eq:    ($("prodEq") ? $("prodEq").checked : true),
    report: ($("prodReport") ? $("prodReport").checked : false),
  };
  // AEC far-end reference (a no-op without it) — only send when one is chosen.
  const refSel = $("prodReference");
  if (refSel && refSel.value) opts.reference = refSel.value;
  // Advanced knobs — only override the backend defaults when present.
  if ($("prodBlend"))      opts.mvdr_blend = parseFloat($("prodBlend").value);
  if ($("prodDfnCap"))     opts.dfn_atten_lim_db = parseFloat($("prodDfnCap").value);
  if ($("prodPauseFloor")) opts.pause_floor_db = parseFloat($("prodPauseFloor").value);
  if ($("prodDoaReadout")) opts.doa_readout = $("prodDoaReadout").checked;
  if ($("prodCfar"))       opts.cfar = $("prodCfar").checked;
  // Target-speaker extraction: pass when a speaker is selected via the chip UI.
  if (state.targetAz != null) {
    opts.target_az = state.targetAz;
    if (state.interfererAz != null && state.interfererAz.length > 0) {
      opts.interferer_az = state.interfererAz;
    }
  }
  return opts;
}

/**
 * Run the production voice pipeline on one file and render the result:
 * raw-vs-clean A/B players + the per-stage ran/skip + timing table. This is
 * the app's running pipeline (POST /api/clean → run_production).
 */
async function runProduction(filename) {
  if (!filename) { toast("runProduction called with no filename.", "error"); return false; }
  if (!Busy.acquire(`cleaning ${filename}`)) return false;
  // A speaker azimuth detected on a different recording must not bleed into this
  // run — reset the picker unless it belongs to the file we're about to clean.
  resetSpeakersForFile(filename);
  state.selectedFile = filename;
  const opts = getProdOpts();
  showProgress(`Cleaning voice (${opts.nr})…`);
  try {
    const r = await fetch("/api/clean", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, ...opts }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    qsa(".ps").forEach(s => s.classList.add("done"));
    hideProgress();
    renderProduction(j);
    refreshFiles();
    const skipped = Object.entries(j.stages || {})
      .filter(([, s]) => s && s.ran === false).map(([k]) => k);
    toast(`Clean ready in ${j.elapsed_s}s` +
          (skipped.length ? ` — skipped: ${skipped.join(", ")}` : " — all stages ran ✓"),
          skipped.length ? "warn" : "ok");
    return true;
  } catch (err) {
    console.error("[runProduction]", err);
    hideProgress();
    toast(`Pipeline failed: ${err.message || "unknown error"}`, "error");
    return false;
  } finally {
    Busy.release();
  }
}

/** Render the production result JSON into the results section. */
function renderProduction(j) {
  const stem = j.stem;
  state.currentStem = stem;
  state.currentClean = j.clean;

  if (window.Shell) window.Shell.router.refreshGate();
  const dur = (j.stages && j.stages.mic_capsules && j.stages.mic_capsules.duration_s) || 0;
  $("resultsFile").innerHTML = `<code>${esc(stem)}.wav</code> · ${dur.toFixed(1)} s · ${(j.sr/1000)} kHz · ${j.n_channels} ch`;

  // Headline stats
  const ran = Object.values(j.stages || {}).filter(s => s && s.ran).length;
  const total = Object.keys(j.stages || {}).length;
  const rtf = dur > 0 ? (j.elapsed_s / dur) : 0;
  $("wsElapsed").textContent  = `${j.elapsed_s}s`;
  $("wsStagesRan").textContent = `${ran}/${total}`;
  $("wsRtf").textContent = rtf ? `${rtf.toFixed(2)}×` : "—";

  $("downloadWinnerBtn").onclick = () => { window.location.href = j.clean; };
  // Only enable the Report button when a report was actually rendered this run
  // (it is opt-in now — the "Generate report" checkbox). No path-guessing, else
  // the button would 404 on runs that skipped the matplotlib render.
  setReportButton(j.report || null);
  const rerun = $("rerunProdBtn");
  if (rerun) rerun.onclick = () => runProduction(`${stem}.wav`);
  const pb = $("playoutBtn");
  if (pb) pb.onclick = () => playToDevice(stem);

  // Output title + signal chain reflect what actually ran this pass.
  const bf = (j.stages || {}).beamform || {};
  const targeted = bf.method === "extract_direction" && bf.target_az != null;
  if ($("winnerName")) {
    $("winnerName").textContent = targeted
      ? `Speaker @ ${bf.target_az > 0 ? "+" : ""}${bf.target_az}°` : "Clean voice";
  }
  if ($("winnerFormula")) $("winnerFormula").textContent = buildChainText(j);

  loadABPlayers(j.input, j.clean,
    `raw 8-ch downmix`,
    `${opthLabel(getProdOpts())} · ${j.elapsed_s}s`);
  renderProdStages(j.stages || {}, j.timings || {});
  if (window.Shell) window.Shell.router.navigate("studio");

  // Auto-detect talkers so the picker is pre-populated — but not during a batch
  // run, not if a target is already chosen, and not if we already detected this
  // file (re-runs keep the existing list).
  maybeAutoDetect(stem);
}

/** Build the signal-chain string from the stages that actually ran. */
function buildChainText(j) {
  const st = j.stages || {};
  const ran = k => st[k] && st[k].ran;
  const bf = st.beamform || {};
  const parts = ["calibrate"];
  if (ran("highpass")) parts.push("HPF");
  if (ran("vad")) parts.push("VAD");
  if (ran("doa")) parts.push("DOA");
  if (bf.method === "extract_direction" && bf.target_az != null)
    parts.push(`extract @${bf.target_az > 0 ? "+" : ""}${bf.target_az}°`);
  else if (ran("beamform")) parts.push(`MVDR (${bf.beam_mode || "auto"})`);
  if (ran("dereverb_spectral")) parts.push("dereverb");
  if (ran("dereverb_wpe")) parts.push("WPE");
  if (ran("aec")) parts.push("AEC");
  if (ran("noise_reduction")) parts.push((st.noise_reduction || {}).engine || "NR");
  if (ran("residual_suppress")) parts.push("residual");
  if (ran("automix")) parts.push("automix");
  if (ran("agc_eq_limiter")) parts.push("AGC/EQ");
  parts.push("out");
  return parts.join(" → ");
}

/** Kick off speaker detection after a clean so the picker is ready to use. */
function maybeAutoDetect(stem) {
  if (state.runningAll) return;                    // not during "Clean all"
  if (state.targetAz != null) return;              // already aiming somewhere
  const fname = `${stem}.wav`;
  if (state.speakersFile === fname) return;        // already have this file's list
  detectSpeakers(fname);                           // fire-and-forget (no Busy lock)
}

function opthLabel(o) {
  const dv = (o.dereverb && o.dereverb !== "none") ? ` · derev:${o.dereverb}` : "";
  const tgt = (o.target_az != null) ? ` · target ${o.target_az}°` : "";
  return `NR:${o.nr}${dv} · beam:${o.beam}${o.eq ? " · EQ" : ""}${tgt}`;
}

/** Point the "Report" button at the standalone HTML report (opens in a new tab),
 *  or disable it if no report URL is available. */
function setReportButton(url) {
  const btn = $("viewReportBtn");
  if (!btn) return;
  if (url) {
    btn.removeAttribute("data-disabled");
    btn.onclick = () => window.open(url, "_blank", "noopener");
  } else {
    btn.setAttribute("data-disabled", "");
    btn.onclick = () => toast("No report for this run.", "warn");
  }
}

/** Re-view a previously-cleaned file without re-running (loads output WAVs). */
async function showResults(stem) {
  state.currentStem = stem;
  if (window.Shell) window.Shell.router.refreshGate();
  const clean = `/output/${stem}/clean_prod.wav`;
  state.currentClean = clean;
  $("resultsFile").innerHTML = `<code>${esc(stem)}.wav</code> · <span class="muted">re-run to refresh stage timings</span>`;
  $("downloadWinnerBtn").onclick = () => { window.location.href = clean; };
  setReportButton(`/output/${stem}/report.html`);
  if ($("rerunProdBtn")) $("rerunProdBtn").onclick = () => runProduction(`${stem}.wav`);
  if ($("playoutBtn"))   $("playoutBtn").onclick = () => playToDevice(stem);
  loadABPlayers(`/output/${stem}/input_mono.wav`, clean, "raw 8-ch downmix", "clean_prod.wav");
  if (window.Shell) window.Shell.router.navigate("studio");
}

/** Load raw-input and clean URLs into the two A/B wavesurfer players. */
function loadABPlayers(inputUrl, cleanUrl, inputSub, cleanSub) {
  if (state.wsInput)  { try { state.wsInput.destroy(); }  catch{} state.wsInput = null; }
  if (state.wsWinner) { try { state.wsWinner.destroy(); } catch{} state.wsWinner = null; }

  $("trackInputSub").textContent = inputSub || "raw input";
  $("trackWinnerSub").textContent = cleanSub || "clean";

  const tc = themeColors();
  state.wsInput = WaveSurfer.create({
    container: "#waveInput",
    waveColor: tc.waveRaw,
    progressColor: tc.waveRawProg,
    height: 64, cursorColor: tc.waveCursor,
    barWidth: 2, barGap: 1, barRadius: 1,
  });
  if (inputUrl) state.wsInput.load(inputUrl);

  state.wsWinner = WaveSurfer.create({
    container: "#waveWinner",
    waveColor: tc.waveClean,
    progressColor: tc.waveCleanProg,
    height: 64, cursorColor: tc.waveCursor,
    barWidth: 2, barGap: 1, barRadius: 1,
  });
  if (cleanUrl) state.wsWinner.load(cleanUrl);

  qsa(".track-play").forEach(btn => {
    btn.textContent = "▶";
    btn.classList.remove("playing");
    btn.onclick = () => {
      const target = btn.dataset.target;
      const ws = (target === "waveInput") ? state.wsInput : state.wsWinner;
      const other = (target === "waveInput") ? state.wsWinner : state.wsInput;
      if (!ws) return;
      if (other && other.isPlaying()) {
        other.pause();
        const ob = qs(`.track-play[data-target="${target === 'waveInput' ? 'waveWinner' : 'waveInput'}"]`);
        ob.textContent = "▶"; ob.classList.remove("playing");
      }
      ws.playPause();
      btn.textContent = ws.isPlaying() ? "❚❚" : "▶";
      btn.classList.toggle("playing", ws.isPlaying());
    };
  });
  [state.wsInput, state.wsWinner].forEach((ws, idx) => {
    if (!ws) return;
    ws.on("finish", () => {
      const target = idx === 0 ? "waveInput" : "waveWinner";
      const btn = qs(`.track-play[data-target="${target}"]`);
      if (btn) { btn.textContent = "▶"; btn.classList.remove("playing"); }
    });
  });
}


/* Friendly label + one-line detail for each production stage key. */
const PROD_STAGE_LABELS = {
  mic_capsules:   ["① Mic capsules",            s => `${s.n_channels} ch · ${s.sr/1000} kHz · ${s.duration_s}s`],
  mic_health:     ["① Mic health",              s => s.ran ? (s.all_ok ? `all ${s.n_channels} mics OK` : `flagged ${(s.flagged_mics||[]).join(",")} · OK ${s.counts.OK}/${s.n_channels}`) : s.reason],
  calibrate:      ["② Channel calibration",      s => s.ran ? `gains ${(s.gains_db||[]).map(g=>g.toFixed(1)).join("/")} dB` : s.reason],
  highpass:       ["③ High-pass filter",         s => s.ran ? `${s.cutoff_hz} Hz · order ${s.order}` : s.reason],
  noise_floor:    ["③ Noise-floor estimate",     s => s.ran ? `${s.noise_floor_dbfs} dBFS` : s.reason],
  dereverb_wpe:   ["⑧ Dereverb (WPE front-end)", s => s.ran ? `taps ${s.taps} · iters ${s.iterations}` : s.reason],
  dereverb_spectral: ["⑧ Dereverb (spectral)",   s => s.ran ? `late-reverb suppress · ${s.rms_change_db} dB` : s.reason],
  vad:            ["④ VAD / speech detector",    s => s.ran ? `speech ${(s.speech_ratio*100).toFixed(0)}%` : s.reason],
  track_conditioning: ["⑤ Tracking path",        s => s.ran ? `noise-robust ${(s.band_hz||[]).join("–")} Hz` : s.reason],
  doa:            ["⑤ DOA / talker tracking",    s => s.ran ? `az ${(s.az_per_block||[]).join("/")}° · spread ${s.az_spread_deg}°` : s.reason],
  rtf_drift:      ["⑤ RTF-drift movement",        s => s.ran ? `steady ${s.steady_median} · ${s.moved?"moving → tracked":"static → batch"}` : s.reason],
  beamform:       ["⑥ Beamforming (MVDR 8→1)",   s => s.ran ? `${(s.method||"").replace("_beamform","")} · ${s.blend||""}${s.mask&&s.mask!=="snr"?` · mask:${(s.mask_info&&s.mask_info.picked)||s.mask}`:""}` : s.reason],
  aec:            ["⑦ AEC (far-end ref)",        s => s.ran ? `ERLE ${s.erle_db} dB${s.n_taps?` · ${s.n_taps} taps`:""}` : s.reason],
  feedback_risk:  ["⑦ Feedback / howl risk",     s => s.ran ? `${s.risk}${s.suspect_hz?` · ${s.suspect_hz} Hz`:""} (score ${s.risk_score})` : s.reason],
  noise_reduction:["⑧ Noise reduction",          s => s.ran ? `${s.engine}` : s.reason],
  residual_suppress:["⑧ Residual suppressor",     s => s.ran ? `strength ${s.strength} · bed ${s.bed_change_db} dB` : s.reason],
  automix:        ["⑨ Automix / gating",         s => s.ran ? `${s.speech_frames}/${s.total_frames} speech frames` : s.reason],
  agc_eq_limiter: ["⑩ AGC + EQ + limiter",       s => s.ran ? `AGC ${(s.agc&&s.agc.engine)||"rms"}→${s.agc_target_dbfs} dBFS${s.eq&&s.eq.ran?" · EQ":""} · limit ${s.limiter_ceiling}` : s.reason],
  output:         ["⑪ Output (WAV)",             s => s.ran ? `norm ${s.gain_db>=0?"+":""}${s.gain_db} dB` : s.reason],
};

/** Render the production stages + per-stage timing into the results table. */
function renderProdStages(stages, timings) {
  const tkey = { dereverb_wpe: "dereverb_wpe", noise_reduction: "nr",
                 noise_floor: "noise_floor", agc_eq_limiter: "agc_eq_limiter" };
  const rows = Object.entries(PROD_STAGE_LABELS).map(([key, [label, detail]]) => {
    const s = stages[key];
    if (!s) return "";
    const ran = !!s.ran;
    const ms = timings[tkey[key] || key];
    const msTxt = (ms != null) ? `${ms} ms` : "";
    let det = "";
    try { det = detail(s) || ""; } catch { det = ""; }
    return `
      <div class="prod-stage ${ran ? "ran" : "skip"}">
        <div class="psg-mark">${ran ? "✓" : "—"}</div>
        <div class="psg-label">${esc(label)}</div>
        <div class="psg-detail">${esc(String(det))}</div>
        <div class="psg-time">${msTxt}</div>
      </div>`;
  }).join("");
  const total = (timings.TOTAL != null) ? `${(timings.TOTAL/1000).toFixed(2)} s` : "";
  $("leaderboard").innerHTML = rows +
    `<div class="prod-stage prod-stage-total"><div class="psg-mark">Σ</div>
      <div class="psg-label">Total</div><div class="psg-detail"></div>
      <div class="psg-time">${total}</div></div>`;
}

/* ── Stage [11]: output-device playout (USB / analog) ── */
async function loadOutputDevices() {
  const sel = $("playoutDevice");
  if (!sel) return;
  try {
    const r = await fetch("/api/devices_out");
    const j = await r.json();
    if (!j.ok) { sel.innerHTML = `<option value="">Default output</option>`; return; }
    sel.innerHTML = `<option value="">Default output</option>` +
      (j.devices || []).map(d =>
        `<option value="${d.index}"${d.is_default ? " selected" : ""}>${esc(d.name)} (${d.max_output_ch}ch)</option>`
      ).join("");
  } catch {
    sel.innerHTML = `<option value="">Default output</option>`;
  }
}

async function playToDevice(stem) {
  if (!stem) return;
  const sel = $("playoutDevice");
  const device = sel && sel.value !== "" ? sel.value : null;
  try {
    const r = await fetch("/api/playout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stem, device, name: "clean_prod.wav" }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    toast(`🔊 Playing clean output to device${device!=null?` #${device}`:" (default)"} · ${j.duration_s}s`);
  } catch (err) {
    toast(`Playout failed: ${err.message || "unknown error"}`, "error");
  }
}

/* The 6-algorithm instrument UI (leaderboard, beampatterns, DOA radar, band
 * chart, cross-recording verdict) was retired when the production clean-voice
 * pipeline became the only path. Its renderers referenced DOM nodes that no
 * longer exist in index.html, so they are removed outright. `loadVerdict` is
 * kept as a no-op because a few post-mutation callers still invoke it. */
function loadVerdict() { /* retired — no verdict UI in the production build */ }


/* ═══════════════════ UTIL ═══════════════════ */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function toast(msg, type) {
  const wrap = $("toastWrap");
  if (!wrap) return;

  // Dedup: same exact message within 1.2 s = ignore (prevents spam)
  const now = Date.now();
  if (toast._last && toast._last.msg === msg && (now - toast._last.ts) < 1200) {
    return;
  }
  toast._last = { msg, ts: now };

  const t = document.createElement("div");
  t.className = "toast" + (type ? " " + type : "");
  // preserve line breaks from server errors
  t.style.whiteSpace = "pre-wrap";
  t.textContent = msg;

  // dismiss button
  const close = document.createElement("button");
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "×";
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return; dismissed = true;
    t.style.transition = "opacity 0.3s, transform 0.3s";
    t.style.opacity = "0";
    t.style.transform = "translateX(40px)";
    setTimeout(() => t.remove(), 350);
  };
  close.addEventListener("click", dismiss);
  t.appendChild(close);

  wrap.appendChild(t);
  const dur = type === "error" ? 7000 : type === "warn" ? 6000 : 3000;
  setTimeout(dismiss, dur);
}


/* ═══════════════════ MODAL ═══════════════════
 * showModal({ icon, title, body, buttons }) → Promise<string>
 * buttons: [{ id, label, variant: 'primary'|'danger'|'ghost'|undefined }]
 * The promise resolves with the clicked button's id, or "cancel" on Esc /
 * backdrop click. Only one modal can be open at a time. Body accepts HTML.
 */
let _activeModal = null;
function showModal({ icon = "ℹ", iconType = "", title, body, buttons }) {
  return new Promise(resolve => {
    // Close any existing modal first
    if (_activeModal) _activeModal.close("cancel");

    const root = $("modalRoot");
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");

    const btnHtml = buttons.map(b =>
      `<button class="modal-btn ${b.variant || ''}" data-id="${esc(b.id)}">${esc(b.label)}</button>`
    ).join("");

    back.innerHTML = `
      <div class="modal-panel">
        <div class="modal-head">
          <div class="modal-icon ${esc(iconType)}">${esc(icon)}</div>
          <div class="modal-title">${esc(title)}</div>
        </div>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">${btnHtml}</div>
      </div>`;

    let closed = false;
    const close = (id) => {
      if (closed) return; closed = true;
      _activeModal = null;
      back.style.transition = "opacity 0.18s";
      back.style.opacity = "0";
      setTimeout(() => back.remove(), 200);
      resolve(id);
    };

    // Button clicks
    back.querySelectorAll(".modal-btn").forEach(b =>
      b.addEventListener("click", () => close(b.dataset.id)));

    // Backdrop click → cancel
    back.addEventListener("click", e => {
      if (e.target === back) close("cancel");
    });

    root.appendChild(back);
    _activeModal = { close };

    // Auto-focus first non-ghost button if any, else first button
    setTimeout(() => {
      const focusable = back.querySelector(".modal-btn.primary, .modal-btn.danger")
                     || back.querySelector(".modal-btn");
      if (focusable) focusable.focus();
    }, 30);
  });
}

/* ═══════════════════ GLOBAL ESC KEY ═══════════════════ */
/* ═══════════════════ KEYBOARD SHORTCUTS ═══════════════════
 * Esc      — close modal / dismiss toast
 * /        — focus filter search input
 * R        — refresh files
 * ↑/↓      — move focus between file rows
 * Enter    — analyse (or view results for) the focused file
 * D        — delete the focused file (via existing modal)
 * ?        — show shortcuts cheat sheet
 *
 * Shortcuts are suppressed while the user is typing in an input,
 * textarea, contenteditable, or select element — so renaming a file,
 * typing in the filter box, etc. all work normally.
 */
function isTypingInField() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function focusedFileIdx() {
  const rows = qsa(".file-row");
  if (!rows.length) return -1;
  const el = document.activeElement;
  for (let i = 0; i < rows.length; i++) if (rows[i] === el) return i;
  return -1;
}

function focusFileRow(idx) {
  const rows = qsa(".file-row");
  if (!rows.length) return;
  const n = rows.length;
  const i = ((idx % n) + n) % n;   // wrap around
  rows.forEach(r => r.classList.remove("file-row-focused"));
  rows[i].classList.add("file-row-focused");
  rows[i].focus({ preventScroll: false });
  rows[i].scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showShortcutsHelp() {
  showModal({
    icon: "⌨",
    title: "Keyboard shortcuts",
    body: `
      <div class="shortcuts-grid">
        <div class="sc-key">↑ / ↓</div><div class="sc-desc">Move between file rows</div>
        <div class="sc-key">Enter</div> <div class="sc-desc">Analyse or view the focused file</div>
        <div class="sc-key">D</div>     <div class="sc-desc">Delete the focused file</div>
        <div class="sc-key">R</div>     <div class="sc-desc">Refresh files list</div>
        <div class="sc-key">/</div>     <div class="sc-desc">Jump to filter search</div>
        <div class="sc-key">Esc</div>   <div class="sc-desc">Close modal or dismiss toast</div>
        <div class="sc-key">?</div>     <div class="sc-desc">Show this help</div>
      </div>
      <p style="font-size:12px;color:var(--muted);margin-top:14px;">
        Shortcuts are disabled while typing in a text field.
      </p>`,
    buttons: [{ id: "ok", label: "Got it", variant: "primary" }],
  });
}

window.addEventListener("keydown", e => {
  // Esc — always works, even in fields
  if (e.key === "Escape") {
    if (_activeModal) { _activeModal.close("cancel"); return; }
    const wrap = $("toastWrap");
    if (wrap && wrap.lastElementChild) {
      const closeBtn = wrap.lastElementChild.querySelector(".toast-close");
      if (closeBtn) { closeBtn.click(); return; }
    }
    // Esc on a focused file row clears the focus
    const focused = document.querySelector(".file-row-focused");
    if (focused) {
      focused.classList.remove("file-row-focused");
      focused.blur();
    }
    return;
  }

  // All other shortcuts: skip if user is typing
  if (isTypingInField()) return;
  // Skip if a modal is open
  if (_activeModal) return;
  // Skip combinations with modifier keys (Ctrl/Cmd-X is the OS's job)
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === "?" || (e.shiftKey && e.key === "/")) {
    e.preventDefault();
    showShortcutsHelp();
    return;
  }

  if (e.key === "/") {
    e.preventDefault();
    const filt = $("filesFilter");
    if (filt) { filt.focus(); filt.select(); }
    return;
  }

  if (e.key.toLowerCase() === "r") {
    e.preventDefault();
    refreshFiles();
    toast("Files refreshed");
    return;
  }

  // File-row navigation
  const rows = qsa(".file-row");
  if (!rows.length) return;
  const cur = focusedFileIdx();

  if (e.key === "ArrowDown") {
    e.preventDefault();
    focusFileRow(cur === -1 ? 0 : cur + 1);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    focusFileRow(cur === -1 ? rows.length - 1 : cur - 1);
    return;
  }
  if (cur === -1) return;        // remaining shortcuts only work on a focused row

  if (e.key === "Enter") {
    e.preventDefault();
    const btn = rows[cur].querySelector('[data-action="analyse"]');
    if (btn) btn.click();
    return;
  }
  if (e.key.toLowerCase() === "d") {
    e.preventDefault();
    const btn = rows[cur].querySelector('[data-action="delete"]');
    if (btn) btn.click();
    return;
  }
});
