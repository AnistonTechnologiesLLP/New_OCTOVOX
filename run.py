#!/usr/bin/env python3
"""
=========================================================================
  OCTOVOX  —  top-level launcher
=========================================================================
  Run:    python run.py
  Open:   http://127.0.0.1:5050

  Thin entrypoint around the ``octovox_app`` package. Builds the Flask app
  via the app-factory, prints a readiness banner, warms up optional neural
  models, and starts the development server.
=========================================================================
"""
import logging
import os
import socket
import sys

from octovox_app import create_app, config
from octovox_app.services import pipeline as ov


def _lan_ip():
    """Best-effort LAN IP of this machine (the address other devices on the
    same network use). Opens a UDP socket to a public IP to discover which
    local interface would route out — no packets are actually sent."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def _force_utf8_console():
    """The pipeline prints Unicode banners/progress; on Windows the default
    console codec (cp1252) can't encode them and crashes. Switch stdout/stderr
    to UTF-8 (best-effort) so logging never aborts a run."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def main():
    _force_utf8_console()
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    # Auto-reload on file save (opt-in: OCTOVOX_RELOAD=1). No Node / extra deps
    # needed — Werkzeug's reloader ships with Flask. Edit a .py and the server
    # restarts itself; edit a template/JS/CSS and just refresh the browser.
    reload_on = os.environ.get("OCTOVOX_RELOAD", "0") != "0"
    # Under the reloader Werkzeug runs TWO processes: a watcher parent and the
    # serving child (WERKZEUG_RUN_MAIN == "true"). Only the serving process
    # prints the banner and warms up models, else everything runs twice.
    is_serving = (not reload_on) or os.environ.get("WERKZEUG_RUN_MAIN") == "true"

    app = create_app()
    if reload_on:
        app.config["TEMPLATES_AUTO_RELOAD"] = True   # .html edits show on refresh

    if is_serving:
        bar = "─" * 60
        print(f"\n{bar}")
        print("  OCTOVOX")
        print(f"  This device:      http://127.0.0.1:{config.PORT}")
        if config.HOST == "0.0.0.0":
            print(f"  Same network:     http://{_lan_ip()}:{config.PORT}")
            print("  (open the 'Same network' URL on any phone/laptop on the same Wi-Fi)")
        else:
            print(f"  Bound to:         http://{config.HOST}:{config.PORT}")
        if reload_on:
            print("  Auto-reload:      ON (save a .py → restarts; save html/js → just refresh)")
        print(bar)
        # OCTOVOX-MAX (DFN polish) is intentionally disabled in the pipeline, so
        # readiness is based on the 5 main algorithms, which need WPE + VAD for
        # the SOTA (Neural-MVDR-WPE) slot.
        sota_ok = ov.HAS_WPE and ov.HAS_VAD
        if sota_ok:
            print("  All 5 algorithms ready")
        else:
            missing = []
            if not ov.HAS_WPE: missing.append("nara-wpe")
            if not ov.HAS_VAD: missing.append("torch")
            print(f"  Missing optional deps: {', '.join(missing)}")
            print("  → Neural-MVDR-WPE (SOTA slot) will be skipped")
        print(bar)
        try:
            ov.warm_up_models()
        except Exception:
            pass
        print(bar + "\n")

    # use_reloader: watch source and restart on save. use_debugger stays OFF —
    # the server binds 0.0.0.0 (LAN), and Werkzeug's interactive debugger would
    # expose remote code execution to anyone on the network.
    app.run(host=config.HOST, port=config.PORT, threaded=True,
            debug=False, use_reloader=reload_on, use_debugger=False)


if __name__ == "__main__":
    main()
