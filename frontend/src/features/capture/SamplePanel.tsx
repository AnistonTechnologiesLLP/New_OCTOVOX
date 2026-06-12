/* Sample panel — ports setupSamplePanel (app.js:562-600, index.html:155-169):
   Target SNR -5..+15 dB step 1 default +5 (label keeps the explicit "+"),
   Duration 3..12 s step 1 default 6; Generate acquires the busy lock, calls
   /api/sample, then hands off to the auto-clean. */

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useShellCommand } from '../../components/shell/commands';
import { useCleanRun } from '../../hooks/useCleanStream';
import { api } from '../../lib/api';
import type { RecordResult } from '../../lib/types';
import { useSession } from '../../state/session';
import { toast } from '../../state/toasts';

/** Legacy accepts `j.filename || j.name` (app.js:582); the backend's wav_info
 *  payload uses `name`. */
function resultName(j: RecordResult): string | null {
  const r = j as Partial<RecordResult> & { name?: string };
  return r.filename || r.name || null;
}

export default function SamplePanel() {
  const queryClient = useQueryClient();
  const runClean = useCleanRun();
  const [snr, setSnr] = useState(5);
  const [duration, setDuration] = useState(6);
  const [generating, setGenerating] = useState(false);

  const generate = async (): Promise<void> => {
    const session = useSession.getState();
    if (!session.acquire('generating sample')) return;
    setGenerating(true);
    let handedOff = false;
    try {
      session.showProgress('Generating synthetic 8-channel sample...');
      const j = await api.sample({ snr_db: snr, seconds: duration });
      const fname = resultName(j);
      if (fname) {
        toast(`Sample generated: ${fname} / analysing...`);
        void queryClient.invalidateQueries({ queryKey: ['files'] });
        // Release first so the clean run can re-acquire (app.js:585-587).
        handedOff = true;
        setGenerating(false);
        session.release();
        await runClean(fname);
      } else {
        session.hideProgress();
        toast('Sample failed: unknown', 'error');
      }
    } catch (err) {
      console.error('[SamplePanel]', err);
      session.hideProgress();
      const msg = err instanceof Error ? err.message : 'unknown';
      toast(`Sample failed: ${msg}`, 'error');
    } finally {
      if (!handedOff) {
        setGenerating(false);
        session.release();
      }
    }
  };

  // Palette command — available while the Sample panel is mounted (capture
  // drawer open); the static "Generate sample" palette action only navigates
  // here, this one actually generates (busy lock guards re-entry).
  useShellCommand({
    id: 'generate-sample',
    label: 'Generate sample now',
    hint: 'Capture',
    run: () => {
      void generate();
    },
    when: () => !generating,
  });

  return (
    <div className="cap-stack">
      <p className="cap-copy">
        Synthetic 8-channel recording with a known speaker direction and noise - try the console
        without hardware.
      </p>
      <div className="cap-grid">
        <div>
          <label className="cap-lab" htmlFor="cap-sample-snr">
            Target SNR{' '}
            <span className="cap-lab-val">
              {snr >= 0 ? '+' : ''}
              {snr} dB
            </span>
          </label>
          <input
            id="cap-sample-snr"
            className="cap-slider"
            type="range"
            min={-5}
            max={15}
            step={1}
            value={snr}
            onChange={(e) => setSnr(Number(e.target.value))}
          />
        </div>
        <div>
          <label className="cap-lab" htmlFor="cap-sample-dur">
            Duration <span className="cap-lab-val">{duration} s</span>
          </label>
          <input
            id="cap-sample-dur"
            className="cap-slider"
            type="range"
            min={3}
            max={12}
            step={1}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </div>
      </div>
      <div className="cap-actions">
        <button className="btn btn-primary" disabled={generating} onClick={() => void generate()}>
          {generating ? 'Generating...' : 'Generate & clean'}
        </button>
      </div>
    </div>
  );
}
