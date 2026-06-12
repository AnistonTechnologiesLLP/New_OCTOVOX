/* Typed fetch client for the OCTOVOX Flask API. Non-2xx /api/ responses and
   network failures are tapped into the error log (replacing the legacy
   errlog.js window.fetch wrap — same /api/-only surface). */

import { record } from './errlog';
import type {
  CleanResult,
  DeviceInfo,
  EnvInfo,
  FileEntry,
  OutputDeviceInfo,
  PreflightResult,
  ProdOpts,
  RecordResult,
  SpeakersResult,
  UploadResult,
  VerdictResult,
} from './types';

function shortUrl(u: string): string {
  try { return new URL(u, location.href).pathname; } catch { return u; }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (/\/api\//.test(url)) record('error', `Network error / ${shortUrl(url)}`, String(e));
    throw e;
  }
  if (!res.ok && /\/api\//.test(url)) {
    record('error', `HTTP ${res.status} / ${shortUrl(url)}`, `${init?.method || 'GET'} ${url}`);
  }
  let j: unknown;
  try {
    j = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = j as { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return j as T;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const api = {
  listInput: () => request<{ files: FileEntry[] }>('/api/list_input'),
  devices: () => request<{ ok: boolean; devices: DeviceInfo[] }>('/api/devices'),
  devicesOut: () =>
    request<{ ok: boolean; devices: OutputDeviceInfo[]; default?: number }>('/api/devices_out'),
  env: () => request<EnvInfo>('/api/env'),
  geometries: () => request<{ geometries: string[]; default: string }>('/api/geometries'),
  verdict: () => request<VerdictResult>('/api/verdict'),

  /* Capture endpoints keep byte-identical request bodies with the legacy UI
     (channels/samplerate are server defaults, and /api/sample ignores its
     body — sent anyway for payload parity). */
  preflight: (body: { device: number | null; seconds?: number }) =>
    postJson<PreflightResult>('/api/preflight', { channels: 8, samplerate: 48000, ...body }),
  recordAudio: (body: { device: number | null; seconds: number; filename?: string }) =>
    postJson<RecordResult>('/api/record', { channels: 8, samplerate: 48000, ...body }),
  sample: (body: { snr_db: number; seconds: number }) =>
    postJson<RecordResult>('/api/sample', { snr_db: body.snr_db, duration_s: body.seconds }),

  /** Upload bypasses request(): multipart body, and HTTP 400 carries the
   *  duplicate / spec-rejection payloads which are flows, not errors
   *  (legacy contract: app.js:448-528). "Save as" is done client-side by
   *  re-uploading a renamed File; "Replace" sends overwrite=1. */
  upload: async (file: File, opts?: { overwrite?: boolean }): Promise<UploadResult> => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    if (opts?.overwrite) fd.append('overwrite', '1');
    let res: Response;
    try {
      res = await fetch('/api/upload', { method: 'POST', body: fd });
    } catch (e) {
      record('error', 'Network error / /api/upload', String(e));
      throw e;
    }
    if (!res.ok && res.status !== 400) {
      record('error', `HTTP ${res.status} / /api/upload`, `POST /api/upload (${file.name})`);
      throw new Error(`Server returned HTTP ${res.status}`);
    }
    return (await res.json()) as UploadResult;
  },

  clean: (filename: string, opts: ProdOpts) =>
    postJson<CleanResult>('/api/clean', { filename, ...opts }),
  speakers: (filename: string) => postJson<SpeakersResult>('/api/speakers', { filename }),
  rt60: (filename: string) => postJson<unknown>('/api/rt60', { filename }),

  deleteFile: (filename: string) =>
    postJson<{ ok: boolean; deleted: string; restore_token: string }>('/api/delete', { filename }),
  restoreFile: (token: string) =>
    postJson<{ ok: boolean; restored: string }>('/api/restore', { token }),
  renameFile: (old_name: string, new_name: string) =>
    // server contract (routes/api.py:371-372): keys are `from` / `to`
    postJson<{ ok: boolean; old: string; new: string }>('/api/rename', { from: old_name, to: new_name }),
  clearOutput: () => postJson<{ ok: boolean; removed: number }>('/api/clear_output', {}),

  playout: (stem: string, device: string | null, name = 'clean_prod.wav') =>
    postJson<{ ok: boolean; playing: boolean; device: number | null; sr: number; duration_s: number }>(
      '/api/playout',
      { stem, device, name },
    ),
};
