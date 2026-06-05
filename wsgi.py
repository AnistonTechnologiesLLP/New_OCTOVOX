"""WSGI entrypoint for production servers (gunicorn / uWSGI).

The dev launcher ``run.py`` is for local use — it prints a banner, warms up
optional neural models, and starts Werkzeug's threaded dev server. Under a
real WSGI server you instead point at the ``app`` object below, e.g.::

    gunicorn --workers 1 --threads 4 --bind 0.0.0.0:5050 wsgi:app

IMPORTANT — keep ``--workers 1``: job state (upload/process progress) lives in
an in-process dict (``octovox_app.utils.jobs.JOBS``). Multiple worker processes
would each hold a *different* copy, so a browser polling for a job could hit a
worker that never ran it. Concurrency comes from ``--threads`` instead, which
share one process and therefore one JOBS dict. This mirrors ``run.py``'s
``threaded=True`` single-process model.
"""
from octovox_app import create_app
from octovox_app.services import pipeline as ov

app = create_app()

# Warm up optional neural models once at boot (best-effort; a missing optional
# dep is logged and skipped, never fatal — same contract as run.py).
try:
    ov.warm_up_models()
except Exception:
    pass
