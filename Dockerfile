# ─────────────────────────────────────────────────────────────────────────
#  OCTOVOX — production image
#
#  Ships the CORE 6-beamformer pipeline only (requirements.txt). The neural
#  extras (torch / DeepFilterNet2 / nara-wpe) are intentionally left out: they
#  add 2+ GB and the app degrades gracefully without them (each missing algo is
#  logged and skipped). To bake them in, add a build stage that also runs
#  `pip install -r requirements-optional.txt` against the CPU torch index.
#
#  Python is pinned to 3.11 — it's the version the optional torch wheels target,
#  so an extras-enabled derivative image works without changing the base.
# ─────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS base

# - libportaudio2: sounddevice loads it lazily (live-record endpoints); without
#   it those endpoints raise, but the rest of the app still imports & runs.
# - libsndfile1: soundfile (optional DFN pilot WAV I/O).
# - curl: container HEALTHCHECK below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        libportaudio2 libsndfile1 curl \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    OCTOVOX_HOST=0.0.0.0 \
    OCTOVOX_PORT=5050

WORKDIR /app

# Install deps first (cached unless requirements.txt changes). gunicorn is the
# production WSGI server; it is a deploy-only dep so it lives here, not in
# requirements.txt (which the dev `run.py` flow doesn't need).
COPY requirements.txt .
RUN pip install --upgrade pip \
 && pip install -r requirements.txt gunicorn

# App code.
COPY . .

# Run as an unprivileged user; pre-create the writable runtime dirs it owns.
RUN useradd --create-home --uid 10001 octovox \
 && mkdir -p data/input data/output octovox_app/static/uploads \
 && chown -R octovox:octovox /app
USER octovox

EXPOSE 5050

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${OCTOVOX_PORT}/api/geometries" || exit 1

# Single worker (in-process JOBS state — see wsgi.py); threads give concurrency.
# Long timeout: a process_file run on a big recording can take a while.
CMD ["sh", "-c", "exec gunicorn --workers 1 --threads 4 --timeout 600 --bind 0.0.0.0:${OCTOVOX_PORT} wsgi:app"]
