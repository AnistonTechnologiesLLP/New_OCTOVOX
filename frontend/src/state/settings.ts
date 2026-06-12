/* Studio DSP settings — persisted to the SAME localStorage key and id-keyed
   shape as the legacy UI ('octovox.studioSettings.v1', app.js:1341-1370) so
   returning users keep their settings: value-type controls stored as strings
   under their legacy element ids ("prodNr": "dfn", "prodResidual": "0.6"),
   checkboxes as booleans. Reference (file-specific) and Report (per-run
   intent) are intentionally NOT persisted.

   Defaults mirror the legacy template's selected options
   (templates/index.html:231-321): preset quality, nr dfn, beam auto,
   movement rtf, mask auto, agc rms, aec partitioned, dereverb none,
   residual 0.6, track+eq on, blend 0.6, dfnCap 32, pauseFloor -40. */

import { create } from 'zustand';
import { PROD_PRESETS, type PresetName } from '../lib/constants';
import type { ProdOpts } from '../lib/types';
import { useSession } from './session';

export interface StudioSettings {
  preset: PresetName;
  nr: string;
  beam: string;
  movement: string;
  mask: string;
  agc: string;
  aec: string;
  dereverb: string;
  residual: number;
  track: boolean;
  eq: boolean;
  report: boolean;
  reference: string;
  blend: number;
  dfnCap: number;
  pauseFloor: number;
  doaReadout: boolean;
  cfar: boolean;
}

export const DEFAULT_SETTINGS: StudioSettings = {
  preset: 'quality',
  nr: 'dfn',
  beam: 'auto',
  movement: 'rtf',
  mask: 'auto',
  agc: 'rms',
  aec: 'partitioned',
  dereverb: 'none',
  residual: 0.6,
  track: true,
  eq: true,
  report: false,
  reference: '',
  blend: 0.6,
  dfnCap: 32,
  pauseFloor: -40,
  doaReadout: false,
  cfar: false,
};

const KEY = 'octovox.studioSettings.v1';

/** Legacy element-id mapping for the persisted shape. */
const ID_MAP: Record<string, keyof StudioSettings> = {
  prodPreset: 'preset',
  prodNr: 'nr',
  prodBeam: 'beam',
  prodMovement: 'movement',
  prodMask: 'mask',
  prodAgc: 'agc',
  prodAec: 'aec',
  prodDereverb: 'dereverb',
  prodResidual: 'residual',
  prodBlend: 'blend',
  prodDfnCap: 'dfnCap',
  prodPauseFloor: 'pauseFloor',
  prodTrack: 'track',
  prodEq: 'eq',
  prodDoaReadout: 'doaReadout',
  prodCfar: 'cfar',
};

const BOOL_KEYS = new Set<keyof StudioSettings>(['track', 'eq', 'doaReadout', 'cfar']);
const NUM_KEYS = new Set<keyof StudioSettings>(['residual', 'blend', 'dfnCap', 'pauseFloor']);

/** Knobs that flip the preset back to "custom" when touched (app.js:1399-1405).
 *  Movement/AGC/AEC/track/eq etc. deliberately do NOT. */
const PRESET_SENSITIVE = new Set<keyof StudioSettings>([
  'nr', 'beam', 'mask', 'dereverb', 'residual', 'blend', 'dfnCap', 'pauseFloor',
]);

function restore(): StudioSettings {
  const s: StudioSettings = { ...DEFAULT_SETTINGS };
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(localStorage.getItem(KEY) || 'null') as Record<string, unknown> | null;
  } catch {
    data = null;
  }
  if (!data) return s;
  for (const [id, key] of Object.entries(ID_MAP)) {
    if (!(id in data)) continue;
    const v = data[id];
    if (BOOL_KEYS.has(key)) {
      (s[key] as boolean) = !!v;
    } else if (NUM_KEYS.has(key)) {
      const n = parseFloat(String(v));
      if (Number.isFinite(n)) (s[key] as number) = n;
    } else {
      (s[key] as string) = String(v);
    }
  }
  return s;
}

function persist(s: StudioSettings): void {
  const data: Record<string, unknown> = {};
  for (const [id, key] of Object.entries(ID_MAP)) {
    const v = s[key];
    // legacy shape: checkbox booleans, everything else the element's string value
    data[id] = BOOL_KEYS.has(key) ? !!v : String(v);
  }
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* private mode */ }
}

interface SettingsStore extends StudioSettings {
  set: <K extends keyof StudioSettings>(key: K, value: StudioSettings[K]) => void;
  applyPreset: (name: PresetName) => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...restore(),
  set: (key, value) => {
    const patch: Partial<StudioSettings> = { [key]: value } as Partial<StudioSettings>;
    if (PRESET_SENSITIVE.has(key) && get().preset !== 'custom') patch.preset = 'custom';
    set(patch);
    persist({ ...get(), ...patch });
  },
  applyPreset: (name) => {
    if (name === 'custom') {
      set({ preset: 'custom' });
      persist({ ...get(), preset: 'custom' });
      return;
    }
    const p = PROD_PRESETS[name];
    const patch: Partial<StudioSettings> = {
      preset: name,
      nr: p.nr,
      beam: p.beam,
      mask: p.mask,
      residual: p.residual,
      dereverb: p.dereverb,
    };
    set(patch);
    persist({ ...get(), ...patch });
  },
}));

/** Serialize the current knobs into the /api/clean payload — field-for-field
 *  identical to legacy getProdOpts() (app.js:1465-1496), including the
 *  target-speaker fields from the session store. */
export function getProdOpts(): ProdOpts {
  const s = useSettings.getState();
  const session = useSession.getState();
  const opts: ProdOpts = {
    nr: s.nr,
    beam: s.beam,
    agc: s.agc,
    aec: s.aec,
    movement: s.movement,
    mask: s.mask,
    track: s.track ? 'conditioned' : 'audio',
    dereverb: s.dereverb,
    residual: s.residual,
    eq: s.eq,
    report: s.report,
    mvdr_blend: s.blend,
    dfn_atten_lim_db: s.dfnCap,
    pause_floor_db: s.pauseFloor,
    doa_readout: s.doaReadout,
    cfar: s.cfar,
  };
  if (s.reference) opts.reference = s.reference;
  if (session.targetAz != null) {
    opts.target_az = session.targetAz;
    if (session.interfererAz.length > 0) opts.interferer_az = session.interfererAz;
  }
  return opts;
}
