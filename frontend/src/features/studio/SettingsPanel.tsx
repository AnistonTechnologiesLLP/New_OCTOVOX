/* Studio DSP control panel — every knob from the legacy prodControls column
   (index.html:226-332, setupProdControls app.js:1372-1442), bound to the
   useSettings store (which owns persistence + the custom-preset flip).
   NEW (PORTING.md §7): capability gating from GET /api/env disables the DFN
   and WPE options (and notes the VAD fallback) when the server lacks them.
   Collapses into a toggleable section below 1080px (studio.css). */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import PresetBar from './PresetBar';
import SpeakerCard from './SpeakerCard';
import { useCleanRun } from '../../hooks/useCleanStream';
import { api } from '../../lib/api';
import { useSession } from '../../state/session';
import { useSettings } from '../../state/settings';

export default function SettingsPanel({ stem }: { stem: string | null }) {
  const s = useSettings();
  const selectedFile = useSession((st) => st.selectedFile);
  const runClean = useCleanRun();
  const [open, setOpen] = useState(false);

  const files = useQuery({ queryKey: ['files'], queryFn: api.listInput });
  const env = useQuery({ queryKey: ['env'], queryFn: api.env });

  // Until /api/env answers, assume capabilities exist (no flash of disabled
  // options); the legacy UI had no gating at all.
  const hasDfn = env.data?.has_dfn ?? true;
  const hasWpe = env.data?.has_wpe ?? true;
  const hasVad = env.data?.has_vad ?? true;

  // populateReferencePicker semantics (app.js:1444-1462): the picker mirrors
  // the input file list, preserves the current choice while that file still
  // exists, and drops it once the file is gone. On a fetch failure the
  // current choice stays listed (options left untouched).
  useEffect(() => {
    const data = files.data;
    if (!data) return;
    const ref = useSettings.getState().reference;
    if (ref && !data.files.some((f) => f.name === ref)) {
      useSettings.getState().set('reference', '');
    }
  }, [files.data]);

  const refNames = files.data
    ? files.data.files.map((f) => f.name)
    : s.reference
      ? [s.reference]
      : [];

  // app.js:1373-1382 — residual live label with verbal tag, ported exactly.
  const residualTag =
    s.residual <= 0
      ? ' (off)'
      : s.residual < 0.45
        ? ' (gentle)'
        : s.residual < 0.8
          ? ' (natural)'
          : ' (aggressive)';

  // Legacy re-run semantics: the viewed stem wins, else the last selected file.
  const runTarget = stem ? `${stem}.wav` : selectedFile;

  return (
    <aside className={`studio-settings card${open ? ' open' : ''}`} aria-label="Pipeline settings">
      <button
        type="button"
        className="settings-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>Pipeline settings</span>
        <span className="settings-toggle-chev" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>

      <div className="settings-body">
        <PresetBar />

        <div className="ctl-group">
          <div className="ctl-group-head">Noise &amp; Beam</div>
          <label className="ctl">
            <span className="ctl-lab">Noise reduction</span>
            <select className="inp" value={s.nr} onChange={(e) => s.set('nr', e.target.value)}>
              <option
                value="dfn"
                disabled={!hasDfn}
                title={!hasDfn ? 'DeepFilterNet3 is not installed on this server' : undefined}
              >
                Natural - DeepFilterNet3
              </option>
              <option
                value="omlsa"
                title={
                  !hasVad ? 'webrtcvad not installed - OM-LSA uses an energy VAD fallback' : undefined
                }
              >
                Near-natural - OM-LSA + VAD (no DF3)
              </option>
              <option value="fast">Fast - decision-directed</option>
              <option value="none">None (beam only)</option>
            </select>
          </label>
          {!hasDfn && (
            <div className="ctl-hint">DeepFilterNet3 unavailable on this server - DFN disabled.</div>
          )}
          {!hasVad && (
            <div className="ctl-hint">webrtcvad unavailable - VAD stages use an energy fallback.</div>
          )}
          <label className="ctl">
            <span className="ctl-lab">Beam</span>
            <select className="inp" value={s.beam} onChange={(e) => s.set('beam', e.target.value)}>
              <option value="auto">Auto (batch, switches on movement)</option>
              <option value="batch">Batch</option>
              <option value="tracked">Tracked (moving)</option>
            </select>
          </label>
          <label className="ctl">
            <span className="ctl-lab">Movement</span>
            <select
              className="inp"
              value={s.movement}
              onChange={(e) => s.set('movement', e.target.value)}
            >
              <option value="srp">SRP-PHAT (azimuth)</option>
              <option value="rtf">RTF drift (auto-switch)</option>
            </select>
          </label>
          <label className="ctl">
            <span className="ctl-lab">Mask</span>
            <select className="inp" value={s.mask} onChange={(e) => s.set('mask', e.target.value)}>
              <option value="snr">SNR (baseline)</option>
              <option value="auto">Coherence auto (safe)</option>
              <option value="coherent">Coherence (always)</option>
            </select>
          </label>
        </div>

        <div className="ctl-group">
          <div className="ctl-group-head">Echo &amp; Reverb</div>
          <label className="ctl">
            <span className="ctl-lab">AEC</span>
            <select className="inp" value={s.aec} onChange={(e) => s.set('aec', e.target.value)}>
              <option value="partitioned">Partitioned (long tail)</option>
              <option value="single">Single-tap</option>
            </select>
          </label>
          <label className="ctl">
            <span className="ctl-lab">AEC reference</span>
            <select
              className="inp"
              title="Far-end loudspeaker feed for echo cancellation - without it AEC is a no-op"
              value={s.reference}
              onChange={(e) => s.set('reference', e.target.value)}
            >
              <option value="">None (AEC off)</option>
              {refNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="ctl">
            <span className="ctl-lab">Dereverb</span>
            <select
              className="inp"
              value={s.dereverb}
              onChange={(e) => s.set('dereverb', e.target.value)}
            >
              <option value="none">None</option>
              <option value="spectral">Spectral (fast)</option>
              <option
                value="wpe"
                disabled={!hasWpe}
                title={!hasWpe ? 'WPE is not installed on this server (nara_wpe)' : undefined}
              >
                WPE (quality, slow)
              </option>
            </select>
          </label>
          {!hasWpe && (
            <div className="ctl-hint">WPE unavailable on this server - option disabled.</div>
          )}
        </div>

        <div className="ctl-group">
          <div className="ctl-group-head">Levels &amp; EQ</div>
          <label className="ctl">
            <span className="ctl-lab">AGC</span>
            <select className="inp" value={s.agc} onChange={(e) => s.set('agc', e.target.value)}>
              <option value="perceptual">Perceptual (attack/release)</option>
              <option value="rms">RMS (instantaneous)</option>
            </select>
          </label>
          <label className="ctl">
            <span className="ctl-lab">
              <span>Denoise strength</span>
              <span className="ctl-val">{s.residual.toFixed(2) + residualTag}</span>
            </span>
            <input
              type="range"
              className="inp inp-range"
              min={0}
              max={1}
              step={0.05}
              value={s.residual}
              onChange={(e) => s.set('residual', parseFloat(e.target.value))}
            />
          </label>
          <label className="ctl-chk">
            <input
              type="checkbox"
              checked={s.track}
              onChange={(e) => s.set('track', e.target.checked)}
            />
            <span>Noise-robust tracking</span>
          </label>
          <label className="ctl-chk">
            <input type="checkbox" checked={s.eq} onChange={(e) => s.set('eq', e.target.checked)} />
            <span>EQ</span>
          </label>
          <label className="ctl-chk">
            <input
              type="checkbox"
              checked={s.report}
              onChange={(e) => s.set('report', e.target.checked)}
            />
            <span>Generate report</span>
          </label>
        </div>

        <details className="ctl-advanced">
          <summary>Advanced</summary>
          <label className="ctl">
            <span className="ctl-lab">
              <span>Off-axis blend</span>
              <span className="ctl-val">{s.blend.toFixed(2)}</span>
            </span>
            <input
              type="range"
              className="inp inp-range"
              min={0}
              max={1}
              step={0.05}
              value={s.blend}
              title="MVDR/downmix blend - higher keeps more of the off-axis speakers"
              onChange={(e) => s.set('blend', parseFloat(e.target.value))}
            />
          </label>
          <label className="ctl">
            <span className="ctl-lab">
              <span>DFN cap</span>
              <span className="ctl-val">{`${s.dfnCap} dB`}</span>
            </span>
            <input
              type="range"
              className="inp inp-range"
              min={12}
              max={48}
              step={2}
              value={s.dfnCap}
              title="DeepFilterNet3 max attenuation - higher = quieter bed but less natural"
              onChange={(e) => s.set('dfnCap', parseFloat(e.target.value))}
            />
          </label>
          <label className="ctl">
            <span className="ctl-lab">
              <span>Pause floor</span>
              <span className="ctl-val">{`-${Math.abs(s.pauseFloor)} dB`}</span>
            </span>
            <input
              type="range"
              className="inp inp-range"
              min={-60}
              max={-12}
              step={2}
              value={s.pauseFloor}
              title="Automix silence floor - deeper = quieter gaps between words"
              onChange={(e) => s.set('pauseFloor', parseFloat(e.target.value))}
            />
          </label>
          <label className="ctl-chk">
            <input
              type="checkbox"
              checked={s.doaReadout}
              onChange={(e) => s.set('doaReadout', e.target.checked)}
            />
            <span>DOA azimuth readout (diagnostic)</span>
          </label>
          <label
            className="ctl-chk"
            title="CA-CFAR adaptive local noise floor for the speech mask - helps under non-stationary noise (HVAC swells, fans, knocks). Experimental."
          >
            <input
              type="checkbox"
              checked={s.cfar}
              onChange={(e) => s.set('cfar', e.target.checked)}
            />
            <span>CFAR adaptive noise floor (experimental)</span>
          </label>
        </details>

        <SpeakerCard />

        <div className="settings-run">
          <button
            className="btn btn-primary settings-run-btn"
            disabled={!runTarget}
            title={
              runTarget
                ? `Run the clean pipeline on ${runTarget}`
                : 'Open a file first - clean a recording from the Library'
            }
            onClick={() => {
              if (runTarget) void runClean(runTarget);
            }}
          >
            Run clean
          </button>
        </div>
      </div>
    </aside>
  );
}
