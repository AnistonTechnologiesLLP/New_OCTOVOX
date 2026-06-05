"""JSON API routes.

All ``/api/...`` endpoints from the original monolithic ``app.py``, preserved
with identical paths and response shapes. Recording/upload/file-management,
pipeline launch (streaming + legacy poll), environment info and verdicts.
"""
import json
import time
import traceback
import uuid
import threading

import numpy as np
from scipy.io import wavfile
from flask import Blueprint, jsonify, request, send_file, Response
from werkzeug.utils import secure_filename

from ..config import INPUT_DIR, OUTPUT_DIR, ASSET_DIR, STATIC_DIR
from ..services import pipeline as ov
from ..services import clean_cascade as cascade
from ..services import prod_pipeline as prod
from ..services.verdicts import collect_verdicts
from ..utils.audio import wav_info
from ..utils.files import safe_input_name
from ..utils.jobs import JOBS, JOBS_LOCK

api_bp = Blueprint("api", __name__, url_prefix="/api")


# ---- Recording -------------------------------------------------------------
@api_bp.route("/devices")
def list_devices():
    try:
        import sounddevice as sd
        try:
            sd._terminate(); sd._initialize()
        except Exception:
            pass
        devs = sd.query_devices()
        out = []
        for i, d in enumerate(devs):
            if d.get("max_input_channels", 0) >= 1:
                out.append({
                    "index"          : i,
                    "name"           : d["name"],
                    "max_input_ch"   : int(d["max_input_channels"]),
                    "default_sr"     : int(d.get("default_samplerate", 0) or 0),
                    "is_polaris_like": d["max_input_channels"] >= 8,
                })
        return jsonify(ok=True, devices=out)
    except ImportError:
        return jsonify(ok=False,
            error="sounddevice not installed. Run: pip3 install sounddevice")
    except Exception as e:
        return jsonify(ok=False, error=str(e))


@api_bp.route("/preflight", methods=["POST"])
def preflight():
    """Brief 0.3 s test recording to verify device is alive and check levels."""
    try:
        import sounddevice as sd
        data = request.get_json(silent=True) or {}
        device = data.get("device")
        if device == "":
            device = None
        if device is not None:
            try: device = int(device)
            except: pass
        channels = int(data.get("channels", 8))
        sr       = int(data.get("samplerate", 48000))
        try:
            rec = sd.rec(int(0.3 * sr), samplerate=sr, channels=channels,
                         device=device, dtype="float32", blocking=True)
        except Exception as e:
            return jsonify(ok=False, error=f"recording test failed: {e}")
        per_ch_peak = [float(np.max(np.abs(rec[:, c]))) for c in range(rec.shape[1])]
        per_ch_rms  = [float(np.sqrt(np.mean(rec[:, c]**2))) for c in range(rec.shape[1])]
        per_ch_peak_db = [20*np.log10(p + 1e-12) for p in per_ch_peak]
        per_ch_rms_db  = [20*np.log10(p + 1e-12) for p in per_ch_rms]
        warnings = []
        if all(p < 1e-4 for p in per_ch_peak):
            warnings.append("All channels silent — check mic power & connections")
        elif min(per_ch_peak) < 1e-4:
            dead = [i for i, p in enumerate(per_ch_peak) if p < 1e-4]
            warnings.append(f"Channels appear silent: {dead}")
        if max(per_ch_peak) > 0.95:
            warnings.append("Possible clipping — reduce input gain")
        if max(per_ch_peak) < 0.005 and max(per_ch_peak) > 1e-4:
            warnings.append("Very low signal — speak louder or raise gain")
        return jsonify(ok=True,
                       per_ch_peak_db=per_ch_peak_db,
                       per_ch_rms_db=per_ch_rms_db,
                       warnings=warnings,
                       samplerate=sr,
                       channels=channels)
    except Exception as e:
        traceback.print_exc()
        return jsonify(ok=False, error=str(e))


@api_bp.route("/record", methods=["POST"])
def record():
    try:
        import sounddevice as sd
        data = request.get_json(silent=True) or {}
        device = data.get("device")
        if device == "":
            device = None
        if device is not None:
            try: device = int(device)
            except: pass
        seconds  = float(data.get("seconds", 6.0))
        channels = int(data.get("channels", 8))
        sr       = int(data.get("samplerate", ov.FS_REQUIRED))
        fname    = data.get("filename") or f"rec_{int(time.time())}.wav"
        fname    = secure_filename(fname)
        if not fname.lower().endswith(".wav"):
            fname += ".wav"

        # Record as int32 to preserve 24-bit native depth from sensiBel
        # (sounddevice maps 24-bit hardware input into the int32 container).
        rec = sd.rec(int(seconds * sr), samplerate=sr, channels=channels,
                     device=device, dtype="int32", blocking=True)
        # Map int32 → float in [-1, 1] for level analysis
        rec_f = (rec.astype(np.float64) / 2147483648.0)

        per_ch_peak = [float(np.max(np.abs(rec_f[:, c]))) for c in range(rec_f.shape[1])]
        per_ch_rms  = [float(np.sqrt(np.mean(rec_f[:, c]**2))) for c in range(rec_f.shape[1])]
        peak = float(max(per_ch_peak)) if per_ch_peak else 0.0
        per_ch_peak_db = [20*np.log10(p + 1e-12) for p in per_ch_peak]
        per_ch_rms_db  = [20*np.log10(r + 1e-12) for r in per_ch_rms]

        warnings = []
        if peak < 1e-4:
            warnings.append(
                f"Recording is essentially silent (peak {20*np.log10(peak+1e-12):.0f} dBFS). "
                f"Check that the sensiBel kit is powered, the audio interface is selected, "
                f"and the OS input level isn't muted. Run 'Test mics' to verify each channel.")
        elif peak < 0.003:
            warnings.append(
                f"Very low signal (peak {20*np.log10(peak):.0f} dBFS). "
                f"Speak louder or raise input gain on the audio interface.")
        if peak > 0.98:
            warnings.append("Signal clipping detected — reduce input gain before re-recording.")
        dead = [i for i, p in enumerate(per_ch_peak) if p < 1e-4]
        if dead and len(dead) < channels:
            warnings.append(f"Channels with no signal: {dead}. The other channels look fine.")

        # Normalize so a healthy peak hits −1 dBFS (90% FS); leave silent
        # recordings untouched so the user sees silence, not fabricated noise.
        if peak > 1e-4:
            gain = 0.90 / peak
            rec_norm = rec_f * gain
        else:
            rec_norm = rec_f
            gain = 1.0

        # Save as 24-bit-range PCM in a 32-bit int container.
        scaled = np.clip(rec_norm * 2147483647.0, -2147483648.0, 2147483647.0).astype(np.int32)
        out_path = INPUT_DIR / fname
        wavfile.write(str(out_path), sr, scaled)

        info = wav_info(out_path)
        info["ok"] = True
        info["peak"] = peak
        info["peak_dbfs"] = 20*np.log10(peak + 1e-12)
        info["per_ch_peak_db"] = per_ch_peak_db
        info["per_ch_rms_db"]  = per_ch_rms_db
        info["gain_applied_db"] = 20*np.log10(gain) if gain > 0 else 0.0
        info["warnings"] = warnings
        return jsonify(info)
    except Exception as e:
        traceback.print_exc()
        return jsonify(ok=False, error=str(e))


# ---- File management -------------------------------------------------------
@api_bp.route("/upload", methods=["POST"])
def upload():
    try:
        if "file" not in request.files:
            return jsonify(ok=False, error="no file in request")
        f = request.files["file"]
        if f.filename == "":
            return jsonify(ok=False, error="empty filename")
        fname = secure_filename(f.filename)
        if not fname.lower().endswith(".wav"):
            return jsonify(ok=False, error="only .wav files accepted")
        target = INPUT_DIR / fname

        # Duplicate detection: refuse to silently overwrite. Frontend gets a
        # friendly response with a suggested non-colliding name.
        overwrite = (request.form.get("overwrite", "0") == "1")
        if target.exists() and not overwrite:
            stem = target.stem
            ext  = target.suffix
            suggested = fname
            for i in range(1, 1000):
                cand = f"{stem}_{i}{ext}"
                if not (INPUT_DIR / cand).exists():
                    suggested = cand
                    break
            existing_info = wav_info(target)
            return jsonify(ok=False,
                           duplicate=True,
                           name=fname,
                           suggested_name=suggested,
                           existing_size_kb=existing_info.get("size_kb", 0),
                           existing_duration=existing_info.get("duration", 0))

        f.save(str(target))
        info = wav_info(target)

        # Validate against sensiBel SB-POLARIS spec (8 ch @ 48 kHz).
        problems, warnings = [], []
        if info["channels"] != ov.N_CH:
            problems.append(
                f"Expected {ov.N_CH} channels (sensiBel SB-POLARIS has 8 mics), "
                f"got {info['channels']}.")
        if info["samplerate"] != ov.FS_REQUIRED:
            problems.append(
                f"Expected {ov.FS_REQUIRED} Hz sample rate (sensiBel runs at 48 kHz "
                f"native), got {info['samplerate']} Hz.")
        if info["duration"] < 1.5:
            warnings.append(
                f"Very short recording ({info['duration']:.1f} s); "
                f"results may be unreliable. Recommended ≥3 s.")
        if info["duration"] > 60:
            warnings.append(
                f"Long recording ({info['duration']:.1f} s) — "
                f"processing may take a while.")
        if info["peak"] < 0.001:
            warnings.append(
                "Audio is essentially silent. Check that mics are powered "
                "and the source is producing sound.")
        if info["peak"] > 0.99:
            warnings.append(
                "Audio appears clipped (peak ≥ 0.99). Reduce input gain "
                "before re-recording for best results.")

        # Hard reject: delete the file and return the problems list.
        if problems:
            try: target.unlink()
            except Exception: pass
            return jsonify(ok=False,
                           error="File does not match sensiBel SB-POLARIS spec",
                           problems=problems,
                           required={"channels": ov.N_CH,
                                     "samplerate": ov.FS_REQUIRED,
                                     "format": "WAV PCM"},
                           got={"channels": info["channels"],
                                "samplerate": info["samplerate"]}), 400

        info["ok"] = True
        info["warnings"] = warnings
        info["replaced"] = overwrite
        return jsonify(info)
    except Exception as e:
        traceback.print_exc()
        return jsonify(ok=False, error=str(e))


@api_bp.route("/list_input")
def list_input():
    files = [wav_info(p) for p in sorted(INPUT_DIR.glob("*.wav"))]
    return jsonify(files=files)


@api_bp.route("/delete", methods=["POST"])
def delete_file():
    data = request.get_json(silent=True) or {}
    name = data.get("filename")
    p = safe_input_name(name)
    if p is None:
        return jsonify(ok=False, error="invalid filename"), 400
    if not p.exists():
        return jsonify(ok=False, error="not found"), 404
    p.unlink()
    # Also delete any output dir derived from this file.
    out_p = OUTPUT_DIR / p.stem
    if out_p.exists() and out_p.is_dir():
        import shutil; shutil.rmtree(out_p)
    return jsonify(ok=True, deleted=name)


@api_bp.route("/clear_output", methods=["POST"])
def clear_output():
    """Delete every per-recording output directory, wiping all analysis results.

    Input .wav files are left untouched — only the derived /output/<stem>
    folders (audio, visualizations, metrics.json, report.html) are removed.
    The .gitkeep placeholder and any stray non-directory files are preserved.
    """
    import shutil
    removed = 0
    for child in sorted(OUTPUT_DIR.iterdir()):
        if child.is_dir():
            try:
                shutil.rmtree(child)
                removed += 1
            except Exception:
                pass
    return jsonify(ok=True, removed=removed)


@api_bp.route("/rename", methods=["POST"])
def rename_file():
    data = request.get_json(silent=True) or {}
    src = safe_input_name(data.get("from"))
    dst_name = data.get("to") or ""
    if not dst_name.lower().endswith(".wav"):
        dst_name += ".wav"
    dst = safe_input_name(dst_name)
    if src is None or dst is None:
        return jsonify(ok=False, error="invalid filename"), 400
    if not src.exists():
        return jsonify(ok=False, error="source not found"), 404
    if dst.exists():
        return jsonify(ok=False, error="target already exists"), 409
    src.rename(dst)
    # Rename the derived output dir too, if present.
    old_out = OUTPUT_DIR / src.stem
    new_out = OUTPUT_DIR / dst.stem
    if old_out.exists() and old_out.is_dir() and not new_out.exists():
        old_out.rename(new_out)
    return jsonify(ok=True, old=data.get("from"), new=dst.name)


@api_bp.route("/sample", methods=["POST"])
def make_sample():
    """Synthetic 8-ch sample for users without hardware."""
    fname = f"sample_{int(time.time())}.wav"
    target = INPUT_DIR / fname
    fs = ov.FS_REQUIRED; dur = 6.0
    n = int(fs * dur)
    t = np.arange(n) / fs
    speech = np.zeros(n, dtype=np.float32)
    seg = (t > 1.0) & (t < 4.0)
    for f0 in (200, 400, 800, 1500):
        speech[seg] += 0.18*np.sin(2*np.pi*f0*t[seg]) * \
                       (0.5+0.5*np.sin(2*np.pi*3*t[seg]))
    speech *= np.exp(-((t-2.5)/1.4)**2)
    rng = np.random.default_rng(int(time.time()))
    mic_pos = ov.POLARIS_UCA_M
    src = np.array([0.5, -0.7, 0.5]); src /= np.linalg.norm(src)
    delays = (-mic_pos @ src / ov.SPEED_SOUND * fs).astype(int)
    y = np.zeros((n, 8), dtype=np.float32)
    for ch in range(8):
        d = delays[ch]
        if d > 0:  y[d:, ch] += speech[:n-d]
        else:      y[:n+d, ch] += speech[-d:]
        y[:, ch] += 0.02*rng.standard_normal(n).astype(np.float32)
        y[:, ch] += 0.015*np.sin(2*np.pi*60*t)
    peak = max(np.max(np.abs(y)), 1e-6)
    y_int = (y/peak*0.4*32767).astype(np.int16)
    wavfile.write(str(target), fs, y_int)
    info = wav_info(target); info["ok"] = True
    return jsonify(info)


# ---- Mic image -------------------------------------------------------------
@api_bp.route("/upload_image", methods=["POST"])
def upload_image():
    try:
        if "file" not in request.files:
            return jsonify(ok=False, error="no file"), 400
        f = request.files["file"]
        fname = secure_filename(f.filename or "mic.png")
        if not fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
            return jsonify(ok=False, error="image must be png/jpg/webp/gif"), 400
        # Always save as "mic.<ext>" so the page can display it predictably.
        ext = "." + fname.lower().rsplit(".", 1)[-1]
        save_to = ASSET_DIR / f"mic{ext}"
        for old in ASSET_DIR.glob("mic.*"):
            try: old.unlink()
            except: pass
        f.save(str(save_to))
        return jsonify(ok=True, url=f"/static/uploads/{save_to.name}")
    except Exception as e:
        return jsonify(ok=False, error=str(e))


@api_bp.route("/mic_image")
def mic_image():
    # 1) User upload takes priority.
    for ext in ("png", "jpg", "jpeg", "webp", "gif"):
        p = ASSET_DIR / f"mic.{ext}"
        if p.exists():
            return jsonify(ok=True, url=f"/static/uploads/{p.name}", source="user")
    # 2) Default sensiBel image bundled in /static/assets.
    default = STATIC_DIR / "assets" / "sensibel_default.png"
    if default.exists():
        return jsonify(ok=True, url="/static/assets/sensibel_default.png",
                       source="default")
    return jsonify(ok=False, url=None)


@api_bp.route("/mic_image_reset", methods=["POST"])
def mic_image_reset():
    """Delete any user-uploaded mic photo, reverting to default."""
    removed = 0
    for ext in ("png", "jpg", "jpeg", "webp", "gif"):
        p = ASSET_DIR / f"mic.{ext}"
        if p.exists():
            try: p.unlink(); removed += 1
            except Exception: pass
    return jsonify(ok=True, removed=removed)


# ---- Processing ------------------------------------------------------------
@api_bp.route("/process", methods=["POST"])
def process_stream():
    """Streaming variant — line-delimited JSON progress events.
    Frontend reads this with a streaming fetch reader."""
    data = request.get_json(force=True, silent=True) or {}
    fname = data.get("filename")
    if not fname:
        return jsonify(error="filename required"), 400
    wav_path = INPUT_DIR / secure_filename(fname)
    if not wav_path.exists():
        return jsonify(error=f"file not found: {fname}"), 404

    geometry    = data.get("geometry", "uca_polaris_40mm")
    post_filter = data.get("post_filter", "wiener")
    use_dfn     = bool(data.get("use_dfn", False))
    n_bootstrap = int(data.get("n_bootstrap", 500))

    from queue import Queue, Empty
    q = Queue()
    state = {"result": None, "error": None, "done": False}

    def cb(msg, pct=None):
        q.put({"type": "progress", "message": str(msg), "pct": float(pct or 0)})

    def worker():
        try:
            ov.process_file(
                wav_path, OUTPUT_DIR,
                manual_gain_db=None, geometry=geometry,
                visualize=True, progress_cb=cb,
                post_filter=post_filter, use_dfn=use_dfn,
                n_bootstrap=n_bootstrap)
            state["result"] = {"stem": wav_path.stem}
        except Exception as e:
            traceback.print_exc()
            state["error"] = str(e)
        finally:
            state["done"] = True
            q.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def stream():
        while True:
            try:
                ev = q.get(timeout=60)
            except Empty:
                yield json.dumps({"type": "progress", "message": "still working…", "pct": -1}) + "\n"
                continue
            if ev is None:
                if state.get("error"):
                    yield json.dumps({"type": "error", "message": state["error"]}) + "\n"
                else:
                    yield json.dumps({"type": "done", **(state.get("result") or {})}) + "\n"
                return
            yield json.dumps(ev) + "\n"

    return Response(stream(), mimetype="application/x-ndjson")


@api_bp.route("/process_poll", methods=["POST"])
def process_poll_legacy():
    """Legacy launch-and-poll endpoint preserved for back-compat."""
    data = request.get_json(force=True, silent=True) or {}
    fname = data.get("filename")
    if not fname:
        return jsonify(ok=False, error="filename required"), 400
    wav_path = INPUT_DIR / secure_filename(fname)
    if not wav_path.exists():
        return jsonify(ok=False, error=f"file not found: {fname}"), 404
    geometry = data.get("geometry", "uca_polaris_40mm")
    post_filter = data.get("post_filter", "wiener")
    use_dfn = bool(data.get("use_dfn", False))
    bootstrap_iters = int(data.get("bootstrap_iters", 500))
    job_id = str(uuid.uuid4())[:8]
    with JOBS_LOCK:
        JOBS[job_id] = {"status": "running", "progress": 0, "log": [], "result": None,
                        "error": None, "filename": fname, "started": time.time()}

    def cb(msg, pct):
        with JOBS_LOCK:
            j = JOBS.get(job_id)
            if j is None:
                return
            j["log"].append({"t": time.time()-j["started"], "msg": msg})
            if pct is not None:
                j["progress"] = float(pct)

    def worker():
        try:
            ov.process_file(
                wav_path, OUTPUT_DIR,
                manual_gain_db=None, geometry=geometry,
                visualize=True, progress_cb=cb,
                post_filter=post_filter, use_dfn=use_dfn,
                n_bootstrap=bootstrap_iters)
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j is not None:
                    j["status"] = "done"; j["progress"] = 100.0
                    j["result"] = {"stem": wav_path.stem}
        except Exception as e:
            traceback.print_exc()
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j is not None:
                    j["status"] = "error"; j["error"] = str(e)

    threading.Thread(target=worker, daemon=True).start()
    return jsonify(ok=True, job_id=job_id)


@api_bp.route("/clean", methods=["POST"])
def clean_voice():
    """Production voice pipeline (the app's primary clean-voice path).

    Body: ``{"filename": "<input.wav>", ...knobs}``. Runs the 11-stage
    production chain (``prod_pipeline.run_production``):
    ``calibrate → HPF/noise-floor → WPE → VAD → DOA → MVDR(8→1) → AEC →
    NR → automix → AGC/EQ/limiter → clean WAV`` and writes one clean mono
    ``clean_prod.wav`` beside the per-recording outputs.

    Returns ``{ok, clean, stages, timings, sr, n_channels, elapsed_s}`` where
    ``clean`` is served by ``/output/<path>``. ``stages`` is the per-stage
    ran/skip report and ``timings`` is the per-stage wall-clock (ms) so a skip
    is never silent and the time budget is measurable.

    Speed-first knobs (all optional):
      · ``nr``   : "fast" (Wiener, default, no neural cost) | "dfn" (DeepFilterNet3,
                   best quality but the slow stage) | "none".
      · ``beam`` : "auto" (default — tracked if the talker moved, else batch) |
                   "batch" | "tracked".
      · ``wpe``  : WPE dereverb front-end (default FALSE — it is the slow stage;
                   enable for a quality dereverb pass).
      · ``eq``   : apply the speech EQ (default true).
      · ``agc``  : "perceptual" (default — K-weighted attack/release loudness) |
                   "rms" (instantaneous RMS to target).
      · ``aec``  : "partitioned" (default — multi-tap, long echo tail) | "single"
                   (one-tap NLMS). Only active with a ``reference`` WAV.
      · ``movement`` : "srp" (default — SRP-PHAT azimuth, readout only) | "rtf"
                   (RTF-drift; in beam="auto" it switches to the tracked beam on
                   sustained movement).
      · ``track`` : "conditioned" (default — noise-robust speech-band tracking
                   path so HVAC/projector noise can't steer the beam) | "audio"
                   (track on the raw audio path).
      · ``mvdr_blend`` (0..1, keeps off-axis speakers), ``dfn_atten_lim_db``,
        and ``reference`` (filename of an optional far-end ref WAV for AEC).
    """
    data = request.get_json(force=True, silent=True) or {}
    fname = data.get("filename")
    if not fname:
        return jsonify(ok=False, error="filename required"), 400
    wav_path = INPUT_DIR / secure_filename(fname)
    if not wav_path.exists():
        return jsonify(ok=False, error=f"file not found: {fname}"), 404

    nr = str(data.get("nr", "dfn")).lower()
    if nr not in ("fast", "dfn", "none"):
        nr = "dfn"
    beam = str(data.get("beam", "auto")).lower()
    if beam not in ("auto", "batch", "tracked"):
        beam = "auto"
    wpe = bool(data.get("wpe", False))   # off in the fast path; opt-in quality dereverb
    eq = bool(data.get("eq", True))
    agc = str(data.get("agc", "perceptual")).lower()
    if agc not in ("perceptual", "rms"):
        agc = "perceptual"
    aec = str(data.get("aec", "partitioned")).lower()
    if aec not in ("partitioned", "single"):
        aec = "partitioned"
    movement = str(data.get("movement", "srp")).lower()
    if movement not in ("srp", "rtf"):
        movement = "srp"
    track = str(data.get("track", "conditioned")).lower()
    if track not in ("conditioned", "audio"):
        track = "conditioned"
    try:
        mvdr_blend = max(0.0, min(1.0, float(data.get("mvdr_blend", 0.6))))
    except (TypeError, ValueError):
        mvdr_blend = 0.6
    if "dfn_atten_lim_db" in data and data.get("dfn_atten_lim_db") is None:
        dfn_atten_lim_db = None
    else:
        try:
            dfn_atten_lim_db = float(data.get("dfn_atten_lim_db", 24.0))
        except (TypeError, ValueError):
            dfn_atten_lim_db = 24.0
    # Optional far-end reference for stage [7] AEC (else AEC is a clean skip).
    ref_path = None
    ref_name = data.get("reference")
    if ref_name:
        cand = INPUT_DIR / secure_filename(ref_name)
        if cand.exists():
            ref_path = cand

    try:
        result = prod.run_production(
            wav_path, OUTPUT_DIR, reference_path=ref_path,
            nr=nr, dfn_atten_lim_db=dfn_atten_lim_db, beam=beam,
            mvdr_blend=mvdr_blend, wpe=wpe, eq=eq, agc=agc, aec=aec,
            movement=movement, track=track)
        clean_url = f"/output/{result['stem']}/{result['clean_name']}"
        input_url = f"/output/{result['stem']}/{result['input_name']}"
        report_url = (f"/output/{result['stem']}/{result['report_name']}"
                      if result.get("report_name") else None)
        return jsonify(ok=True,
                       clean=clean_url,
                       input=input_url,
                       report=report_url,
                       stem=result["stem"],
                       stages=result["stages"],
                       timings=result["timings"],
                       sr=result["sr"],
                       n_channels=result["n_channels"],
                       elapsed_s=result["elapsed_s"])
    except Exception as e:
        traceback.print_exc()
        return jsonify(ok=False, error=str(e)), 500


@api_bp.route("/devices_out")
def list_output_devices():
    """List output-capable audio devices for stage [11] playout (USB/analog).
    Mirrors ``/api/devices`` but filters on output channels."""
    try:
        import sounddevice as sd
        try:
            sd._terminate(); sd._initialize()
        except Exception:
            pass
        devs = sd.query_devices()
        try:
            default_out = sd.default.device[1]
        except Exception:
            default_out = None
        out = []
        for i, d in enumerate(devs):
            if d.get("max_output_channels", 0) >= 1:
                out.append({
                    "index"        : i,
                    "name"         : d["name"],
                    "max_output_ch": int(d["max_output_channels"]),
                    "default_sr"   : int(d.get("default_samplerate", 0) or 0),
                    "is_default"   : (i == default_out),
                })
        return jsonify(ok=True, devices=out, default=default_out)
    except ImportError:
        return jsonify(ok=False,
            error="sounddevice not installed. Run: pip3 install sounddevice")
    except Exception as e:
        return jsonify(ok=False, error=str(e))


@api_bp.route("/playout", methods=["POST"])
def playout():
    """Play a produced clean WAV to a chosen output device (USB / analog).

    Body: ``{"stem": "<recording>", "device": <index|null>, "name": "clean_prod.wav"}``.
    Streams the file to the selected ``sounddevice`` output (non-blocking).
    Real Dante/AVB transports need vendor hardware SDKs — out of scope here;
    this covers the USB / analog output the OS exposes.
    """
    data = request.get_json(silent=True) or {}
    stem = data.get("stem")
    if not stem:
        return jsonify(ok=False, error="stem required"), 400
    name = secure_filename(data.get("name") or "clean_prod.wav")
    p = OUTPUT_DIR / secure_filename(stem) / name
    if not p.exists():
        return jsonify(ok=False, error=f"clean file not found: {stem}/{name}"), 404
    device = data.get("device")
    if device in ("", None):
        device = None
    else:
        try: device = int(device)
        except (TypeError, ValueError): device = None
    try:
        import sounddevice as sd
        fs, audio = wavfile.read(str(p))
        if np.issubdtype(audio.dtype, np.integer):
            audio = audio.astype(np.float32) / float(np.iinfo(audio.dtype).max)
        else:
            audio = audio.astype(np.float32)
        sd.stop()
        sd.play(audio, samplerate=int(fs), device=device, blocking=False)
        return jsonify(ok=True, playing=f"{stem}/{name}", device=device,
                       sr=int(fs), duration_s=round(len(audio) / float(fs), 2))
    except ImportError:
        return jsonify(ok=False,
            error="sounddevice not installed. Run: pip3 install sounddevice")
    except Exception as e:
        traceback.print_exc()
        return jsonify(ok=False, error=str(e)), 500


@api_bp.route("/job/<job_id>")
def job_status(job_id):
    with JOBS_LOCK:
        j = JOBS.get(job_id)
        if j is None:
            return jsonify(ok=False, error="not found"), 404
        return jsonify(ok=True, **j)


# ---- Geometry / environment / verdicts -------------------------------------
@api_bp.route("/geometries")
def list_geometries():
    return jsonify(geometries=list(ov.GEOMETRY_PRESETS.keys()),
                   default="uca_polaris_40mm")


@api_bp.route("/env")
def env_info():
    return jsonify(has_dfn=ov.HAS_DFN, has_wpe=ov.HAS_WPE, has_vad=ov.HAS_VAD,
                   has_cuda=ov.HAS_CUDA, gpu_name=ov.GPU_NAME or None,
                   gpu_mem_gb=round(ov.GPU_MEM_GB, 1),
                   cpu_cores=ov._NUM_CORES,
                   fs_required=ov.FS_REQUIRED, n_ch=ov.N_CH, version="OCTOVOX")


@api_bp.route("/verdict")
def verdict_endpoint():
    """Aggregate results across every processed recording."""
    try:
        return jsonify(collect_verdicts(OUTPUT_DIR))
    except Exception as e:
        return jsonify(error=str(e), recordings_analysed=0,
                       per_algo={}, best_algorithm=None,
                       best_summary="", recordings=[]), 200


@api_bp.route("/output_file/<stem>/<fname>")
def serve_output_file(stem, fname):
    """Stream any file from /output/<stem>/<fname>."""
    p = OUTPUT_DIR / stem / fname
    if not p.exists():
        return jsonify(error="not found"), 404
    return send_file(str(p))
