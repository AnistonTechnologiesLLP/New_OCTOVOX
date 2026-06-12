/* Shared domain types for the OCTOVOX API (shapes verified against
   octovox_app/routes/api.py and the legacy app.js consumers). */

export interface FileEntry {
  name: string;
  size_kb: number;
  duration: number;
  samplerate: number;
  channels: number;
  peak: number;
  mtime?: number;
}

export interface DeviceInfo {
  index: number;
  name: string;
  max_input_ch: number;
  default_sr: number;
  is_polaris_like: boolean;
}

export interface OutputDeviceInfo {
  index: number;
  name: string;
  max_output_ch: number;
  default_sr: number;
  is_default: boolean;
}

export interface EnvInfo {
  has_dfn: boolean;
  has_wpe: boolean;
  has_vad: boolean;
  has_cuda: boolean;
  gpu_name: string | null;
  gpu_mem_gb: number | null;
  cpu_cores: number;
  fs_required: number;
  n_ch: number;
  version: string;
}

export interface Speaker {
  az: number;
  strength: number;
  activity: number;
}

export interface SpeakersResult {
  ok: boolean;
  ran: boolean;
  n_speakers: number;
  speakers: Speaker[];
  spectrum?: number[];
  elapsed_s: number;
  reason?: string;
}

/** Per-stage status entry in a clean result. Stage payloads vary per stage;
 *  `ran` and `reason` are the common contract, the rest is stage-specific. */
export interface StageStatus {
  ran: boolean;
  reason?: string;
  [key: string]: unknown;
}

export type StageMap = Record<string, StageStatus>;
export type Timings = Record<string, number>;

export interface CleanResult {
  ok: boolean;
  clean: string;
  input: string;
  report: string | null;
  stem: string;
  stages: StageMap;
  timings: Timings;
  sr: number;
  n_channels: number;
  elapsed_s: number;
}

/** NDJSON events emitted by /api/clean_stream and /api/process. */
export type StreamEvent =
  | { type: 'progress'; message: string; pct: number; stage?: string }
  | { type: 'error'; message: string }
  | ({ type: 'done' } & CleanResult);

/** Serialized DSP options sent to /api/clean and /api/clean_stream — the
 *  field set must stay byte-compatible with legacy getProdOpts()
 *  (app.js:1465-1496) so payload-parity holds at cutover. */
export interface ProdOpts {
  nr: string;
  beam: string;
  agc: string;
  aec: string;
  movement: string;
  mask: string;
  track: 'conditioned' | 'audio';
  dereverb: string;
  residual: number;
  eq: boolean;
  report: boolean;
  reference?: string;
  mvdr_blend?: number;
  dfn_atten_lim_db?: number;
  pause_floor_db?: number;
  doa_readout?: boolean;
  cfar?: boolean;
  target_az?: number;
  interferer_az?: number[];
}

export interface RecordResult {
  ok: boolean;
  /** /api/record returns `filename`; wav_info-shaped responses return `name`
   *  (utils/audio.py) — consumers read `filename || name` like legacy. */
  filename?: string;
  name?: string;
  size_kb: number;
  duration: number;
  samplerate: number;
  channels: number;
  peak: number;
  peak_dbfs: number;
  per_ch_peak_db: number[];
  per_ch_rms_db: number[];
  gain_applied_db?: number;
  warnings: string[];
}

export interface PreflightResult {
  ok: boolean;
  per_ch_peak_db: number[];
  per_ch_rms_db: number[];
  warnings: string[];
  samplerate: number;
  channels: number;
}

export interface UploadResult extends Partial<RecordResult> {
  ok: boolean;
  /** Upload responses use `name` (legacy consumer reads j.name). */
  name?: string;
  replaced?: boolean;
  error?: string;
  /** Spec-mismatch rejection details. */
  problems?: string[];
  /** Duplicate-name flow (HTTP 400 + duplicate:true). */
  duplicate?: boolean;
  suggested_name?: string;
  existing_size_kb?: number;
  existing_duration?: number;
}

export interface VerdictRecording {
  stem: string;
  /** Winning algorithm + confidence (services/verdicts.py:54-60). */
  winner: string;
  confidence: number;
  [key: string]: unknown;
}

export interface VerdictResult {
  recordings_analysed: number;
  per_algo: Record<string, unknown>;
  best_algorithm: string | null;
  best_summary: string | null;
  recordings: VerdictRecording[];
}

export type ToastType = 'ok' | 'warn' | 'error' | undefined;

export interface ToastAction {
  label: string;
  onClick: () => void;
}
