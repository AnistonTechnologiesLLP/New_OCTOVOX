/* Target-speaker picker — ports the legacy speaker-detection block
   (app.js:1104-1237, 1420-1441): Detect (fire-and-forget, NO busy lock —
   legacy detectSpeakers only disables its own button), az-labelled chips,
   the click-to-aim radar with 8-degree snap, and the target readout. */

import { useState } from 'react';
import AzimuthRadar, { azSep, normAz } from './AzimuthRadar';
import { api } from '../../lib/api';
import { useSession } from '../../state/session';
import { toast } from '../../state/toasts';

export default function SpeakerCard() {
  const detectedSpeakers = useSession((s) => s.detectedSpeakers);
  const targetAz = useSession((s) => s.targetAz);
  const interfererAz = useSession((s) => s.interfererAz);
  const setTarget = useSession((s) => s.setTarget);
  const [detecting, setDetecting] = useState(false);

  /** detectSpeakers (app.js:1105-1129, 1421-1425): selectedFile first, else
   *  the current stem; warns when neither exists. */
  const detect = async (): Promise<void> => {
    const s = useSession.getState();
    const fname = s.selectedFile || (s.currentStem ? `${s.currentStem}.wav` : null);
    if (!fname) {
      toast('Select or clean a file first, then detect speakers.', 'warn');
      return;
    }
    setDetecting(true);
    try {
      const j = await api.speakers(fname);
      const speakers = j.speakers || [];
      useSession.getState().setSpeakers(speakers, fname);
      const n = speakers.length;
      toast(
        n > 0
          ? `Found ${n} talker direction${n > 1 ? 's' : ''} - pick one below to extract it.`
          : 'No distinct speaker directions found (may be single-speaker or reverberant).',
        n > 0 ? 'ok' : 'warn',
      );
    } catch (err) {
      toast(`Speaker detect failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setDetecting(false);
    }
  };

  /** selectSpeaker (app.js:1168-1176): target = rounded az; interferers = all
   *  detected azimuths >= 20 deg away. */
  const selectSpeaker = (az: number): void => {
    const interferers = detectedSpeakers.map((sp) => sp.az).filter((a) => azSep(a, az) >= 20);
    setTarget(Math.round(az), interferers);
    const label = `${az > 0 ? '+' : ''}${Math.round(az)} deg`;
    toast(`Will extract speaker at ${label} on next run - click Re-run or analyse a file.`, 'ok');
  };

  /** setManualTarget (app.js:1181-1188): arbitrary radar aim; interferers
   *  from any detected directions >= 20 deg away (else the pipeline
   *  auto-detects them at run time). */
  const setManualTarget = (az: number): void => {
    const norm = normAz(az);
    const others = detectedSpeakers.map((sp) => sp.az).filter((a) => azSep(a, norm) >= 20);
    setTarget(norm, others);
    toast(`Aimed at ${norm > 0 ? '+' : ''}${norm} deg - re-run to extract that direction.`, 'ok');
  };

  /** clearSpeakerSelection (app.js:1191-1196). */
  const clearSelection = (): void => {
    setTarget(null, []);
    toast('Speaker filter cleared - all voices will be processed.', 'ok');
  };

  /** Radar click: snap to a detected talker within 8 deg, else manual aim
   *  (app.js:1432-1438). */
  const onAim = (az: number): void => {
    const near = detectedSpeakers.find((sp) => azSep(sp.az, az) < 8);
    if (near) selectSpeaker(near.az);
    else setManualTarget(az);
  };

  const readout =
    targetAz == null
      ? 'all voices / Detect, or click the radar to aim'
      : `target ${targetAz > 0 ? '+' : ''}${targetAz} deg` +
        (interfererAz.length
          ? ` / nulling ${interfererAz.map((v) => (v > 0 ? '+' : '') + Math.round(v) + ' deg').join(', ')}`
          : '');

  return (
    <div className="ctl-group speaker-card">
      <div className="speaker-head">
        <span className="ctl-group-head">Target speaker</span>
        <button
          className="btn btn-ghost btn-xs"
          disabled={detecting}
          title="Scan recording for talker directions (SRP-PHAT)"
          onClick={() => void detect()}
        >
          {detecting ? '...' : 'Detect'}
        </button>
        {targetAz != null && (
          <button
            className="btn btn-ghost btn-xs"
            title="Remove speaker filter - process all voices"
            onClick={clearSelection}
          >
            Clear
          </button>
        )}
      </div>

      <div className="speaker-chips">
        {detectedSpeakers.length === 0 ? (
          <span className="speaker-empty">Detect to list talkers, or click the radar to aim.</span>
        ) : (
          detectedSpeakers.map((sp, i) => {
            const az = Math.round(sp.az);
            const strength = Math.round((sp.strength || 0) * 100);
            const activity = Math.round((sp.activity || 0) * 100);
            const isActive = targetAz != null && azSep(sp.az, targetAz) < 1.0;
            return (
              <button
                key={`${sp.az}-${i}`}
                className={`speaker-chip${isActive ? ' active' : ''}`}
                title={`Azimuth ${az > 0 ? '+' : ''}${az} deg / strength ${strength}% / activity ${activity}%`}
                onClick={() => (isActive ? clearSelection() : selectSpeaker(sp.az))}
              >
                <span className="sc-dir">{`${az > 0 ? '+' : ''}${az} deg`}</span>
                <span className="sc-bar">
                  <span className="sc-fill" style={{ width: `${strength}%` }} />
                </span>
              </button>
            );
          })
        )}
      </div>

      <AzimuthRadar speakers={detectedSpeakers} targetAz={targetAz} onAim={onAim} />
      <div className={`target-readout${targetAz != null ? ' armed' : ''}`}>{readout}</div>
    </div>
  );
}
