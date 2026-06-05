#!/usr/bin/env python3
"""
=========================================================================
  OCTOVOX — PRODUCTION VOICE REPORT
=========================================================================
Builds a standalone, self-contained ``report.html`` (+ ``visualization.png``)
for one production clean-voice run, the way the old instrument produced a
report — but adapted to the SINGLE-output production path instead of the
6-algorithm bootstrap competition.

The report contains, all embedded (base64) so the file is portable:
  · a hero + KPI strip (duration, levels, noise-floor before→after, engines),
  · raw-vs-clean A/B audio players,
  · a 4-panel visualization (waveforms, raw & clean spectrograms, mic health),
  · diagnostics (mic health table, DOA / movement, feedback risk, noise floor),
  · the full per-stage ran/skip + wall-clock timing table.

Generation NEVER breaks the pipeline: the clean WAV is already written before
this runs, and :func:`build_report` is wrapped so any failure (e.g. matplotlib
missing) just means "no report", not a failed clean.
=========================================================================
"""
import base64
import datetime as _dt
from pathlib import Path

import numpy as np
import scipy.signal as sps

from .clean_cascade import NFFT, HOP, WIN, EPS

# Palette — matches the app's dark pro-audio console + the old report.
_BG = "#0B0F14"
_PANEL = "#141A22"
_TEXT = "#F1F5F9"
_MUTED = "#94A3B8"
_TEAL = "#5EEAD4"
_BLUE = "#5B9BFF"
_ROSE = "#F25C7C"
_GOLD = "#F5C03A"
_STATUS_COLOR = {"OK": _TEAL, "WARN": _GOLD, "FAULT": _ROSE,
                 "DEAD": "#64748B", "CLIP": _ROSE}


# =========================================================================
#  small metric helpers
# =========================================================================
def _rms_dbfs(x):
    return 20.0 * np.log10(np.sqrt(np.mean(x ** 2) + EPS) + EPS)


def _peak_dbfs(x):
    return 20.0 * np.log10(np.max(np.abs(x)) + EPS)


def _floor_dbfs(x, fs, pct=10.0):
    """Broadband noise floor (dBFS) = per-bin 10th-percentile power, summed."""
    try:
        _, _, Z = sps.stft(x, fs=fs, nperseg=NFFT, noverlap=NFFT - HOP,
                           window=WIN, boundary=None)
        noise_psd = np.percentile(np.abs(Z) ** 2, pct, axis=1)
        return 20.0 * np.log10(float(np.sqrt(np.sum(noise_psd) + EPS)) + EPS)
    except Exception:
        return float("nan")


def _b64_file(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


# =========================================================================
#  visualization (matplotlib → PNG)
# =========================================================================
def _make_visualization(png_path, raw_mono, clean_mono, sr, mic_health):
    """4-panel figure: waveforms · raw spectrogram · clean spectrogram · mic health."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(13, 7.5), facecolor=_BG)
    fig.subplots_adjust(hspace=0.32, wspace=0.18, left=0.06, right=0.98, top=0.93, bottom=0.08)

    def _style(ax, title):
        ax.set_facecolor(_PANEL)
        ax.set_title(title, color=_TEXT, fontsize=11, fontweight="bold", loc="left")
        ax.tick_params(colors=_MUTED, labelsize=8)
        for s in ax.spines.values():
            s.set_color("#222B36")

    # ── waveforms (peak-normalized for shape comparison) ──
    ax = axes[0, 0]; _style(ax, "Waveform — raw downmix vs clean")
    rn = raw_mono / (np.max(np.abs(raw_mono)) + EPS)
    cn = clean_mono / (np.max(np.abs(clean_mono)) + EPS)
    t_r = np.arange(len(rn)) / sr
    t_c = np.arange(len(cn)) / sr
    ax.plot(t_r, rn, color=_MUTED, lw=0.5, alpha=0.8, label="raw")
    ax.plot(t_c, cn, color=_TEAL, lw=0.5, alpha=0.9, label="clean")
    ax.set_xlim(0, max(t_r[-1] if len(t_r) else 1, t_c[-1] if len(t_c) else 1))
    ax.set_ylim(-1.05, 1.05); ax.set_xlabel("s", color=_MUTED, fontsize=8)
    ax.legend(loc="upper right", fontsize=8, facecolor=_PANEL, edgecolor="#222B36",
              labelcolor=_TEXT)

    # ── spectrograms ──
    def _spec(ax, x, title):
        _style(ax, title)
        ax.specgram(x, NFFT=NFFT, Fs=sr, noverlap=NFFT - HOP, cmap="magma",
                    vmin=-120, vmax=-20)
        ax.set_ylim(0, min(8000, sr / 2)); ax.set_xlabel("s", color=_MUTED, fontsize=8)
        ax.set_ylabel("Hz", color=_MUTED, fontsize=8)

    _spec(axes[0, 1], raw_mono.astype(np.float64), "Spectrogram — raw downmix")
    _spec(axes[1, 0], clean_mono.astype(np.float64), "Spectrogram — clean output")

    # ── mic health bars ──
    ax = axes[1, 1]; _style(ax, "Mic health — per-capsule RMS (dBFS)")
    pm = (mic_health or {}).get("per_mic", [])
    if pm:
        mics = [m["mic"] for m in pm]
        rms = [m["rms_dbfs"] for m in pm]
        cols = [_STATUS_COLOR.get(m["status"], _BLUE) for m in pm]
        ax.bar(mics, rms, color=cols, edgecolor="#222B36")
        ref = mic_health.get("ref_rms_dbfs")
        if ref is not None:
            ax.axhline(ref, color=_BLUE, lw=1.0, ls="--", alpha=0.7)
        ax.set_xticks(mics); ax.set_xlabel("mic", color=_MUTED, fontsize=8)
        ax.set_ylabel("dBFS", color=_MUTED, fontsize=8)
        ymin = min(rms) - 6
        ax.set_ylim(ymin, max(max(rms) + 3, ymin + 6))
    else:
        ax.text(0.5, 0.5, "mic health unavailable", color=_MUTED, ha="center",
                va="center", transform=ax.transAxes)

    fig.savefig(png_path, dpi=110, facecolor=_BG)
    plt.close(fig)


# =========================================================================
#  per-stage table (mirror of the UI's PROD_STAGE_LABELS)
# =========================================================================
_STAGE_TITLES = {
    "mic_capsules": "① Mic capsules", "mic_health": "① Mic health",
    "calibrate": "② Channel calibration", "highpass": "③ High-pass filter",
    "noise_floor": "③ Noise-floor estimate", "track_conditioning": "⑤ Tracking path",
    "dereverb_wpe": "⑧ Dereverb (WPE front-end)", "vad": "④ VAD / speech detector",
    "doa": "⑤ DOA / talker tracking", "rtf_drift": "⑤ RTF-drift movement",
    "beamform": "⑥ Beamforming (MVDR 8→1)", "aec": "⑦ AEC (far-end ref)",
    "feedback_risk": "⑦ Feedback / howl risk", "noise_reduction": "⑧ Noise reduction",
    "automix": "⑨ Automix / gating", "agc_eq_limiter": "⑩ AGC + EQ + limiter",
    "output": "⑪ Output (WAV)",
}
# stage key → timings key (a few differ)
_TIMING_ALIAS = {"mic_capsules": "load", "noise_reduction": "nr"}


def _stage_detail(key, s):
    if not s.get("ran", False):
        return s.get("reason", "—")
    g = s.get
    if key == "mic_capsules":
        return f"{g('n_channels')} ch · {g('sr', 0)/1000:.0f} kHz · {g('duration_s')}s"
    if key == "mic_health":
        c = s.get("counts", {})
        return ("all mics OK" if s.get("all_ok") else
                f"flagged {s.get('flagged_mics')} · OK {c.get('OK')}/{s.get('n_channels')}")
    if key == "calibrate":
        return "gains " + "/".join(f"{v:.1f}" for v in s.get("gains_db", [])) + " dB"
    if key == "highpass":
        return f"{g('cutoff_hz')} Hz · order {g('order')}"
    if key == "noise_floor":
        return f"{g('noise_floor_dbfs')} dBFS"
    if key == "track_conditioning":
        return f"noise-robust {'-'.join(str(v) for v in s.get('band_hz', []))} Hz"
    if key == "vad":
        return f"speech {g('speech_ratio', 0)*100:.0f}%"
    if key == "doa":
        return f"az {'/'.join(str(v) for v in s.get('az_per_block', []))}° · spread {g('az_spread_deg')}°"
    if key == "rtf_drift":
        return f"steady {g('steady_median')} · {'moving → tracked' if g('moved') else 'static → batch'}"
    if key == "beamform":
        return f"{str(g('method','')).replace('_beamform','')} · {g('blend','')}"
    if key == "aec":
        return f"ERLE {g('erle_db')} dB" + (f" · {g('n_taps')} taps" if g("n_taps") else "")
    if key == "feedback_risk":
        return f"{g('risk')}" + (f" · {g('suspect_hz')} Hz" if g("suspect_hz") else "") + f" (score {g('risk_score')})"
    if key == "noise_reduction":
        return str(g("engine"))
    if key == "automix":
        return f"{g('speech_frames')}/{g('total_frames')} speech frames"
    if key == "agc_eq_limiter":
        eng = (s.get("agc") or {}).get("engine", "rms")
        return f"AGC {eng}→{g('agc_target_dbfs')} dBFS" + (" · EQ" if (s.get('eq') or {}).get('ran') else "") + f" · limit {g('limiter_ceiling')}"
    if key == "output":
        gd = g("gain_db", 0)
        return f"norm {'+' if gd >= 0 else ''}{gd} dB"
    return "ran"


# =========================================================================
#  HTML assembly
# =========================================================================
def _kpi(label, value, cls=""):
    return (f'<div class="kpi"><div class="l">{label}</div>'
            f'<div class="v {cls}">{value}</div></div>')


def _build_html(*, fname, when, params, kpis, players_html, viz_b64,
                diag_html, stage_rows):
    return f"""<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>OCTOVOX — {fname}</title>
<style>
:root{{--bg:{_BG};--panel:{_PANEL};--p3:#232A33;--bd:#222B36;--text:{_TEXT};
  --muted:{_MUTED};--teal:{_TEAL};--blue:{_BLUE};--rose:{_ROSE};--gold:{_GOLD};}}
*{{box-sizing:border-box;}}
body{{margin:0;background:var(--bg);color:var(--text);
  font-family:-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.55;}}
.hero{{background:linear-gradient(135deg,#1B2128,#0B0F14);padding:44px 32px 36px;
  text-align:center;border-bottom:3px solid var(--teal);}}
.hero h1{{margin:0 0 6px;font-size:40px;font-weight:800;letter-spacing:-1px;}}
.hero h1 .grad{{background:linear-gradient(120deg,var(--teal),var(--blue),var(--rose));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;}}
.hero .sub{{color:var(--muted);font-size:14px;}}
.hero .file{{display:inline-block;margin-top:14px;padding:6px 18px;background:#0B0F14;
  border:1px solid var(--teal);border-radius:999px;color:var(--teal);
  font-family:monospace;font-size:13px;}}
.container{{max-width:1300px;margin:0 auto;padding:28px;}}
.card{{background:var(--panel);border-radius:14px;padding:22px;margin-bottom:22px;
  border:1px solid var(--bd);}}
.card h2{{margin:0 0 16px;font-size:18px;}}
.kpi-grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}}
@media (max-width:900px){{.kpi-grid{{grid-template-columns:repeat(2,1fr);}}}}
.kpi{{background:var(--p3);border:1px solid var(--bd);padding:12px 14px;border-radius:10px;}}
.kpi .l{{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}}
.kpi .v{{font-size:19px;font-weight:700;margin-top:4px;font-family:monospace;}}
.kpi .v.green{{color:var(--teal);}}.kpi .v.red{{color:var(--rose);}}
.kpi .v.gold{{color:var(--gold);}}.kpi .v.blue{{color:var(--blue);}}
.ab{{display:grid;grid-template-columns:1fr 1fr;gap:16px;}}
@media (max-width:780px){{.ab{{grid-template-columns:1fr;}}}}
.ab .lab{{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;}}
audio{{width:100%;}}
.viz img{{width:100%;display:block;border-radius:8px;}}
table{{width:100%;border-collapse:collapse;font-size:13px;}}
th,td{{text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd);}}
th{{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}}
td.t{{color:var(--text);}} td.d{{color:var(--muted);font-family:monospace;}}
td.ms{{font-family:monospace;color:var(--blue);text-align:right;}}
.pill{{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;}}
.pill.ran{{background:rgba(94,234,212,.15);color:var(--teal);}}
.pill.skip{{background:rgba(148,163,184,.15);color:var(--muted);}}
.st{{font-weight:700;}} .st.OK{{color:var(--teal);}} .st.WARN{{color:var(--gold);}}
.st.FAULT,.st.CLIP{{color:var(--rose);}} .st.DEAD{{color:#64748B;}}
.diag{{display:grid;grid-template-columns:1.3fr 1fr;gap:16px;}}
@media (max-width:900px){{.diag{{grid-template-columns:1fr;}}}}
.kv{{font-size:13px;}} .kv .row{{display:flex;justify-content:space-between;
  padding:7px 0;border-bottom:1px solid var(--bd);}} .kv .row span:first-child{{color:var(--muted);}}
.foot{{color:var(--muted);font-size:12px;text-align:center;padding:8px 0 28px;}}
</style></head><body>
<div class="hero">
  <h1>OCTOVOX <span class="grad">Voice Report</span></h1>
  <div class="sub">production clean-voice pipeline · {params}</div>
  <div class="file">{fname}</div>
</div>
<div class="container">
  <div class="card"><h2>Summary</h2><div class="kpi-grid">{kpis}</div></div>
  <div class="card"><h2>Listen — raw vs clean</h2><div class="ab">{players_html}</div></div>
  <div class="card viz"><h2>Visualization</h2>
    <img src="data:image/png;base64,{viz_b64}" alt="visualization"></div>
  <div class="card"><h2>Diagnostics</h2>{diag_html}</div>
  <div class="card"><h2>Pipeline stages</h2>
    <table><thead><tr><th>Stage</th><th>Status</th><th>Detail</th><th style="text-align:right;">ms</th></tr></thead>
    <tbody>{stage_rows}</tbody></table></div>
  <div class="foot">Generated {when} · OCTOVOX production pipeline</div>
</div></body></html>"""


# =========================================================================
#  public entry point
# =========================================================================
def build_report(out_dir, stem, fname, *, raw_mono, clean_mono, sr,
                 stages, timings, elapsed_s, clean_path, input_path, params,
                 now=None):
    """Render ``<out_dir>/<stem>/report.html`` (+ ``visualization.png``).

    Returns ``{"report_path": str, "report_name": "report.html", "ran": True}``
    or ``{"ran": False, "reason": ...}``. Never raises — a report failure must
    not fail the clean run (the WAV is already on disk).
    """
    try:
        rec_dir = Path(out_dir) / stem
        rec_dir.mkdir(parents=True, exist_ok=True)
        png = rec_dir / "visualization.png"
        mic_health = stages.get("mic_health", {})
        _make_visualization(png, np.asarray(raw_mono, dtype=np.float32),
                            np.asarray(clean_mono, dtype=np.float32), sr, mic_health)

        when = (now or _dt.datetime.now()).strftime("%Y-%m-%d %H:%M")

        # ── KPIs ──
        in_rms, out_rms = _rms_dbfs(raw_mono), _rms_dbfs(clean_mono)
        floor_raw, floor_clean = _floor_dbfs(raw_mono, sr), _floor_dbfs(clean_mono, sr)
        beam = stages.get("beamform", {})
        nr = stages.get("noise_reduction", {})
        fb = stages.get("feedback_risk", {})
        mh = mic_health.get("counts", {}) if mic_health.get("ran") else {}
        n_ch = stages.get("mic_capsules", {}).get("n_channels", "—")
        dur = stages.get("mic_capsules", {}).get("duration_s", "—")
        kpis = "".join([
            _kpi("Duration", f"{dur} s"),
            _kpi("Channels", f"{n_ch} → 1"),
            _kpi("Process time", f"{elapsed_s} s", "blue"),
            _kpi("Beam", str(beam.get("method", "—")).replace("_beamform", "")),
            _kpi("Input level", f"{in_rms:.1f} dBFS"),
            _kpi("Output level", f"{out_rms:.1f} dBFS", "green"),
            _kpi("Noise floor", f"{floor_raw:.0f} → {floor_clean:.0f} dBFS",
                 "green" if floor_clean < floor_raw else ""),
            _kpi("Mics OK", f"{mh.get('OK', '—')}/{n_ch}" if mh else "—",
                 "green" if mh and mh.get("OK") == n_ch else "gold"),
        ])

        # ── A/B players ──
        players_html = (
            f'<div><div class="lab">Raw 8-ch downmix</div>'
            f'<audio controls src="data:audio/wav;base64,{_b64_file(input_path)}"></audio></div>'
            f'<div><div class="lab">Clean output</div>'
            f'<audio controls src="data:audio/wav;base64,{_b64_file(clean_path)}"></audio></div>')

        # ── diagnostics ──
        pm = mic_health.get("per_mic", []) if mic_health.get("ran") else []
        if pm:
            mic_rows = "".join(
                f'<tr><td class="t">mic {m["mic"]:02d}</td>'
                f'<td class="d">{m["rms_dbfs"]} dBFS</td>'
                f'<td class="d">{m["dev_db"]:+} dB</td>'
                f'<td><span class="st {m["status"]}">{m["status"]}</span></td></tr>'
                for m in pm)
            mic_tbl = ('<table><thead><tr><th>Capsule</th><th>RMS</th><th>Δ median</th>'
                       f'<th>Status</th></tr></thead><tbody>{mic_rows}</tbody></table>')
        else:
            mic_tbl = '<div class="kv"><div class="row"><span>mic health</span><span>—</span></div></div>'

        doa = stages.get("doa", {})
        rtf = stages.get("rtf_drift", {})
        nf = stages.get("noise_floor", {})
        move = ("RTF drift " + str(rtf.get("steady_median")) +
                (" → moving" if rtf.get("moved") else " → static")) if rtf.get("ran") else \
               ("SRP spread " + str(doa.get("az_spread_deg")) + "° → " +
                ("moving" if doa.get("moved") else "static") if doa.get("ran") else "—")
        kv = "".join([
            f'<div class="row"><span>DOA azimuth</span><span>{"/".join(str(v) for v in doa.get("az_per_block", [])) or "—"}°</span></div>',
            f'<div class="row"><span>Movement</span><span>{move}</span></div>',
            f'<div class="row"><span>Feedback risk</span><span>{fb.get("risk","—")}'
            + (f' · {fb.get("suspect_hz")} Hz' if fb.get("suspect_hz") else "") + '</span></div>',
            f'<div class="row"><span>Noise floor</span><span>{nf.get("noise_floor_dbfs","—")} dBFS</span></div>',
            f'<div class="row"><span>Noise reduction</span><span>{nr.get("engine","—")}</span></div>',
        ])
        diag_html = (f'<div class="diag"><div>{mic_tbl}</div>'
                     f'<div class="kv">{kv}</div></div>')

        # ── stage table ──
        rows = []
        for key, s in stages.items():
            title = _STAGE_TITLES.get(key, key)
            ran = bool(s.get("ran", False))
            pill = '<span class="pill ran">ran</span>' if ran else '<span class="pill skip">skip</span>'
            tkey = _TIMING_ALIAS.get(key, key)
            ms = timings.get(tkey, "")
            rows.append(f'<tr><td class="t">{title}</td><td>{pill}</td>'
                        f'<td class="d">{_stage_detail(key, s)}</td>'
                        f'<td class="ms">{ms}</td></tr>')
        stage_rows = "\n".join(rows)

        html = _build_html(fname=fname, when=when, params=params, kpis=kpis,
                           players_html=players_html, viz_b64=_b64_file(png),
                           diag_html=diag_html, stage_rows=stage_rows)
        report = rec_dir / "report.html"
        report.write_text(html, encoding="utf-8")
        return {"ran": True, "report_path": str(report), "report_name": report.name}
    except Exception as e:
        return {"ran": False, "reason": f"error: {e}"}
