/* Payload-parity gate (PORTING.md "Cutover gate"): getProdOpts() must emit
   exactly the field set the legacy getProdOpts() (app.js:1465-1496) produced
   for the same knob state. The expected object below is hand-derived from the
   legacy template defaults (templates/index.html:231-321) run through the
   legacy serializer. */

import { describe, expect, it } from 'vitest';
import { getProdOpts, useSettings, DEFAULT_SETTINGS } from './settings';
import { useSession } from './session';

describe('getProdOpts payload parity', () => {
  it('default knobs serialize to the exact legacy payload', () => {
    useSettings.setState({ ...DEFAULT_SETTINGS });
    useSession.setState({ targetAz: null, interfererAz: [] });
    expect(getProdOpts()).toEqual({
      nr: 'dfn',
      beam: 'auto',
      agc: 'rms',
      aec: 'partitioned',
      movement: 'rtf',
      mask: 'auto',
      track: 'conditioned',
      dereverb: 'none',
      residual: 0.6,
      eq: true,
      report: false,
      mvdr_blend: 0.6,
      dfn_atten_lim_db: 32,
      pause_floor_db: -40,
      doa_readout: false,
      cfar: false,
    });
  });

  it('reference / target_az / interferer_az appear only when set (legacy conditionals)', () => {
    useSettings.setState({ ...DEFAULT_SETTINGS, reference: 'farend.wav' });
    useSession.setState({ targetAz: 45, interfererAz: [-90, 120] });
    const opts = getProdOpts();
    expect(opts.reference).toBe('farend.wav');
    expect(opts.target_az).toBe(45);
    expect(opts.interferer_az).toEqual([-90, 120]);

    useSession.setState({ targetAz: 45, interfererAz: [] });
    const noInterferers = getProdOpts();
    expect(noInterferers.target_az).toBe(45);
    expect('interferer_az' in noInterferers).toBe(false);

    useSettings.setState({ ...DEFAULT_SETTINGS, reference: '' });
    useSession.setState({ targetAz: null, interfererAz: [] });
    const bare = getProdOpts();
    expect('reference' in bare).toBe(false);
    expect('target_az' in bare).toBe(false);
  });

  it('track checkbox maps to conditioned/audio strings', () => {
    useSettings.setState({ ...DEFAULT_SETTINGS, track: false });
    expect(getProdOpts().track).toBe('audio');
    useSettings.setState({ ...DEFAULT_SETTINGS });
  });
});
