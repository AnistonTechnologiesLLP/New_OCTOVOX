/* Constants ported verbatim from the legacy app.js (line refs per item). */

import type { StageStatus } from './types';

export const REQUIRED_CH = 8;
export const REQUIRED_SR = 48000;

/** app.js:12-21 — message-keyword fallback for stage mapping. NOTE (verified):
 *  these stage ids never matched the legacy pill names, so the explicit
 *  NDJSON `ev.stage` field is the working path; keywords kept for parity. */
export const STAGE_KEYWORDS: Record<string, string[]> = {
  load: ['Loaded'],
  stft: ['STFT'],
  mask: ['mask'],
  csm: ['CSM', 'RTF'],
  bf: ['Beamformer', 'beamformers'],
  wpe: ['WPE', 'Neural-MVDR'],
  boot: ['bootstrap', 'Winner'],
  render: ['Saved', 'visualization', 'report', 'metrics.json', 'DONE'],
};

/** The 8 stage groups the /api/clean_stream `stage` field reports, in pipeline
 *  order (server's _PROD_STAGE_MAP emits exactly these ids). */
export const STREAM_STAGES = [
  { id: 'calibrate', label: 'Calibrate' },
  { id: 'highpass', label: 'High-pass' },
  { id: 'vad', label: 'VAD' },
  { id: 'doa', label: 'DOA' },
  { id: 'beamform', label: 'Beamform' },
  { id: 'nr', label: 'Noise reduction' },
  { id: 'automix', label: 'Automix' },
  { id: 'output', label: 'Output' },
] as const;

export type StreamStageId = (typeof STREAM_STAGES)[number]['id'];

/** app.js:1308-1320 — preset knob values, verbatim. */
export const PROD_PRESETS = {
  quality: { nr: 'dfn', beam: 'auto', mask: 'auto', residual: 0.6, dereverb: 'none' },
  balanced: { nr: 'omlsa', beam: 'auto', mask: 'auto', residual: 0.55, dereverb: 'none' },
  fast: { nr: 'fast', beam: 'batch', mask: 'coherent', residual: 0.45, dereverb: 'none' },
} as const;

export type PresetName = keyof typeof PROD_PRESETS | 'custom';

/** app.js:1399-1400 — ONLY these knobs flip the preset back to "custom"
 *  (movement/AGC/AEC etc. deliberately do not). */
export const PRESET_SENSITIVE_KEYS = [
  'nr', 'beam', 'mask', 'dereverb', 'residual', 'blend', 'dfnCap', 'pauseFloor',
] as const;

interface StageView { label: string; detail: (s: StageStatus) => string }

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const str = (v: unknown): string => String(v ?? '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const reason = (s: StageStatus): string => str(s.reason);

/** app.js:1885-1905 — friendly label + one-line detail per stage key, ported
 *  formatter-for-formatter. */
export const PROD_STAGE_LABELS: Record<string, StageView> = {
  mic_capsules: {
    label: 'Mic capsules',
    detail: (s) => `${num(s.n_channels)} ch / ${num(s.sr) / 1000} kHz / ${num(s.duration_s)}s`,
  },
  mic_health: {
    label: 'Mic health',
    detail: (s) =>
      s.ran
        ? s.all_ok
          ? `all ${num(s.n_channels)} mics OK`
          : `flagged ${arr(s.flagged_mics).join(',')} / OK ${num((s.counts as Record<string, unknown> | undefined)?.OK)}/${num(s.n_channels)}`
        : reason(s),
  },
  calibrate: {
    label: 'Channel calibration',
    detail: (s) =>
      s.ran ? `gains ${arr(s.gains_db).map((g) => num(g).toFixed(1)).join('/')} dB` : reason(s),
  },
  highpass: {
    label: 'High-pass filter',
    detail: (s) => (s.ran ? `${num(s.cutoff_hz)} Hz / order ${num(s.order)}` : reason(s)),
  },
  noise_floor: {
    label: 'Noise-floor estimate',
    detail: (s) => (s.ran ? `${num(s.noise_floor_dbfs)} dBFS` : reason(s)),
  },
  dereverb_wpe: {
    label: 'Dereverb (WPE front-end)',
    detail: (s) => (s.ran ? `taps ${num(s.taps)} / iters ${num(s.iterations)}` : reason(s)),
  },
  dereverb_spectral: {
    label: 'Dereverb (spectral)',
    detail: (s) => (s.ran ? `late-reverb suppress / ${num(s.rms_change_db)} dB` : reason(s)),
  },
  vad: {
    label: 'VAD / speech detector',
    detail: (s) => (s.ran ? `speech ${(num(s.speech_ratio) * 100).toFixed(0)}%` : reason(s)),
  },
  track_conditioning: {
    label: 'Tracking path',
    detail: (s) => (s.ran ? `noise-robust ${arr(s.band_hz).join('-')} Hz` : reason(s)),
  },
  doa: {
    label: 'DOA / talker tracking',
    detail: (s) =>
      s.ran ? `az ${arr(s.az_per_block).join('/')} deg / spread ${num(s.az_spread_deg)} deg` : reason(s),
  },
  rtf_drift: {
    label: 'RTF-drift movement',
    detail: (s) =>
      s.ran ? `steady ${str(s.steady_median)} / ${s.moved ? 'moving to tracked' : 'static to batch'}` : reason(s),
  },
  beamform: {
    label: 'Beamforming (MVDR 8-to-1)',
    detail: (s) => {
      if (!s.ran) return reason(s);
      const maskInfo = s.mask_info as { picked?: string } | undefined;
      const maskTxt =
        s.mask && s.mask !== 'snr' ? ` / mask:${(maskInfo && maskInfo.picked) || str(s.mask)}` : '';
      return `${str(s.method).replace('_beamform', '')} / ${str(s.blend ?? '')}${maskTxt}`;
    },
  },
  aec: {
    label: 'AEC (far-end ref)',
    detail: (s) =>
      s.ran ? `ERLE ${num(s.erle_db)} dB${s.n_taps ? ` / ${num(s.n_taps)} taps` : ''}` : reason(s),
  },
  feedback_risk: {
    label: 'Feedback / howl risk',
    detail: (s) =>
      s.ran
        ? `${str(s.risk)}${s.suspect_hz ? ` / ${num(s.suspect_hz)} Hz` : ''} (score ${str(s.risk_score)})`
        : reason(s),
  },
  noise_reduction: {
    label: 'Noise reduction',
    detail: (s) => (s.ran ? str(s.engine) : reason(s)),
  },
  residual_suppress: {
    label: 'Residual suppressor',
    detail: (s) => (s.ran ? `strength ${str(s.strength)} / bed ${num(s.bed_change_db)} dB` : reason(s)),
  },
  automix: {
    label: 'Automix / gating',
    detail: (s) => (s.ran ? `${num(s.speech_frames)}/${num(s.total_frames)} speech frames` : reason(s)),
  },
  agc_eq_limiter: {
    label: 'AGC + EQ + limiter',
    detail: (s) => {
      if (!s.ran) return reason(s);
      const agc = s.agc as { engine?: string } | undefined;
      const eq = s.eq as { ran?: boolean } | undefined;
      return `AGC ${(agc && agc.engine) || 'rms'} to ${num(s.agc_target_dbfs)} dBFS${eq && eq.ran ? ' / EQ' : ''} / limit ${str(s.limiter_ceiling)}`;
    },
  },
  output: {
    label: 'Output (WAV)',
    detail: (s) => (s.ran ? `norm ${num(s.gain_db) >= 0 ? '+' : ''}${num(s.gain_db)} dB` : reason(s)),
  },
};

/** app.js:1909-1910 — stage-key to timings-key mapping for the rack table. */
export const STAGE_TIMING_KEY: Record<string, string> = {
  dereverb_wpe: 'dereverb_wpe',
  noise_reduction: 'nr',
  noise_floor: 'noise_floor',
  agc_eq_limiter: 'agc_eq_limiter',
};

/** app.js:1654-1675 — signal-chain string from the stages that ran. */
export function buildChainText(j: { stages?: Record<string, StageStatus> }): string {
  const st = j.stages || {};
  const ran = (k: string): boolean => !!(st[k] && st[k]!.ran);
  const bf = (st['beamform'] || {}) as StageStatus & { method?: string; target_az?: number; beam_mode?: string };
  const parts = ['calibrate'];
  if (ran('highpass')) parts.push('HPF');
  if (ran('vad')) parts.push('VAD');
  if (ran('doa')) parts.push('DOA');
  if (bf.method === 'extract_direction' && bf.target_az != null)
    parts.push(`extract @${bf.target_az > 0 ? '+' : ''}${bf.target_az} deg`);
  else if (ran('beamform')) parts.push(`MVDR (${bf.beam_mode || 'auto'})`);
  if (ran('dereverb_spectral')) parts.push('dereverb');
  if (ran('dereverb_wpe')) parts.push('WPE');
  if (ran('aec')) parts.push('AEC');
  if (ran('noise_reduction')) parts.push(str((st['noise_reduction'] as StageStatus & { engine?: string }).engine) || 'NR');
  if (ran('residual_suppress')) parts.push('residual');
  if (ran('automix')) parts.push('automix');
  if (ran('agc_eq_limiter')) parts.push('AGC/EQ');
  parts.push('out');
  return parts.join(' -> ');
}
