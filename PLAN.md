# Recreate OCTOVOX in `New_OCTOVOX` as a Proper Runnable Package

## Summary
Rebuild the current flat project into a clean Flask package inside `New_OCTOVOX` while preserving the existing app behavior, routes, UI, and DSP pipeline. The new structure should be runnable on its own, keep the current sample `input` WAV files, and start with an empty/generated-at-runtime `output` area rather than copying the old result folders.

## Key Changes
- Create a package-first layout under `New_OCTOVOX`, with clear separation between web app code, DSP/pipeline logic, templates, static assets, and runtime data.
- Use an app-factory style entrypoint so the server can be started via a small `run.py` or equivalent top-level launcher rather than a monolithic `app.py`.
- Split the current `app.py` responsibilities into modules:
  - Web/app bootstrap and config
  - API routes for recording/upload/file management/process/jobs/verdict/env
  - Shared helpers for path validation, WAV metadata, and job state
- Move the current `octovox.py` into a dedicated pipeline/service module area without changing its core algorithm behavior in the first pass.
- Keep `verdict.py` as a separate helper/service module and wire it through the new package imports.
- Move `templates/` and `static/` under the package so Flask resolves them from the new app location cleanly.
- Keep the same HTTP endpoints and payload shapes used by `static/app.js` so the frontend does not need a behavioral rewrite during the restructure.
- Add a project-level `README.md` for the new structure with new run instructions pointing at `New_OCTOVOX`.
- Add package init files and a small config module for paths such as `input`, `output`, and uploaded assets.
- Copy the current `input/` folder contents into the new runtime data area.
- Do not copy existing generated `output/` recordings/reports; create the directory empty and let the new app populate it.

## Proposed Structure
- `New_OCTOVOX/run.py`
- `New_OCTOVOX/requirements.txt`
- `New_OCTOVOX/README.md`
- `New_OCTOVOX/octovox_app/`
- `New_OCTOVOX/octovox_app/__init__.py`
- `New_OCTOVOX/octovox_app/config.py`
- `New_OCTOVOX/octovox_app/routes/`
- `New_OCTOVOX/octovox_app/services/`
- `New_OCTOVOX/octovox_app/utils/`
- `New_OCTOVOX/octovox_app/templates/`
- `New_OCTOVOX/octovox_app/static/`
- `New_OCTOVOX/data/input/`
- `New_OCTOVOX/data/output/`

Implementation defaults:
- `services/pipeline.py`: adapted from current `octovox.py`
- `services/verdicts.py`: adapted from current `verdict.py`
- `routes/api.py`: all `/api/...` endpoints
- `routes/pages.py`: `/` and output-serving routes
- `utils/files.py`: filename/path safety, directory helpers
- `utils/audio.py`: WAV info and related audio-file helpers

## Public Interfaces / Compatibility
- Preserve the current Flask routes, especially:
  - `/`
  - `/api/devices`
  - `/api/preflight`
  - `/api/record`
  - `/api/upload`
  - `/api/list_input`
  - `/api/delete`
  - `/api/rename`
  - `/api/sample`
  - `/api/upload_image`
  - `/api/mic_image`
  - `/api/mic_image_reset`
  - `/api/process`
  - `/api/process_poll`
  - `/api/job/<job_id>`
  - `/api/geometries`
  - `/api/env`
  - `/api/verdict`
  - `/api/output_file/<stem>/<fname>`
  - `/output/<path:fname>`
- Preserve current JSON response shapes unless a bug forces a change.
- Preserve current frontend asset filenames so template references remain simple during migration.

## Test Plan
- Start the new app from `New_OCTOVOX` and confirm the homepage loads with CSS/JS/assets intact.
- Verify all existing frontend actions still hit working endpoints: file list, upload, rename, delete, sample generation, verdict load.
- Run one full pipeline job against a sample WAV copied into `data/input/` and confirm new outputs are generated in `data/output/<stem>/`.
- Confirm generated `report.html`, `metrics.json`, and audio outputs are downloadable/servable from the new routes.
- Confirm path safety still blocks invalid filenames and path traversal attempts.
- Smoke-test imports so `run.py` launches without relying on the old repo root or `sys.path` hacks.

## Assumptions
- “Proper manner” means a maintainable, modular, runnable Flask application, not just a folder skeleton.
- Existing UI behavior and API compatibility should be preserved during the restructure.
- The first reorganization pass should prioritize structure and import cleanliness over deep algorithm refactoring inside the DSP code.
- Existing generated outputs are disposable artifacts and should not be duplicated into `New_OCTOVOX`.
- The current empty `New_OCTOVOX` directory can be fully used as the destination for this rebuilt structure.
