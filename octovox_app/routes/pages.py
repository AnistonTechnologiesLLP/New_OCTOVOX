"""Page and output-file-serving routes (non-API)."""
from flask import Blueprint, send_from_directory

from ..config import OUTPUT_DIR, STATIC_DIR

pages_bp = Blueprint("pages", __name__)


@pages_bp.route("/")
def index():
    """Serve the OCTOVOX console (a Vite/React app built by ``frontend/`` into
    ``static/ui/``; its assets load from ``/static/ui/``). Engine capability
    flags come from GET /api/env (the old template injection is retired)."""
    return send_from_directory(str(STATIC_DIR / "ui"), "index.html")


@pages_bp.route("/ui")
def new_ui_alias():
    """Cutover alias kept for one release: /ui was the side-by-side preview
    URL during the UI rebuild. Remove after the next release."""
    return send_from_directory(str(STATIC_DIR / "ui"), "index.html")


@pages_bp.route("/acoustics")
def acoustics():
    """Serve the Room Acoustics estimator (a standalone Vite/React app built
    into ``static/acoustics/``; its assets load from ``/static/acoustics/``)."""
    return send_from_directory(str(STATIC_DIR / "acoustics"), "index.html")


@pages_bp.route("/output/<path:fname>")
def serve_output(fname):
    return send_from_directory(str(OUTPUT_DIR), fname)
