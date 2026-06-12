/* Record panel — ports the legacy record flow (app.js:219-406): device
   enumeration sorted Polaris-first with auto-select, <8-channel validation
   warning, 2-30 s duration slider, preflight level meters, the recording
   countdown, the silent-recording guard (peak < -70 dBFS refuses to analyse),
   and the busy hand-off to the auto-clean. */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import LevelMeters from './LevelMeters';
import { useCleanRun } from '../../hooks/useCleanStream';
import { api } from '../../lib/api';
import { REQUIRED_CH, REQUIRED_SR } from '../../lib/constants';
import type { RecordResult } from '../../lib/types';
import { useSession } from '../../state/session';
import { toast } from '../../state/toasts';

interface Levels {
  peak: number[];
  rms: number[];
  warnings: string[];
}

/** The backend names the saved file `name` (wav_info), legacy sample also saw
 *  `filename` — accept either (app.js:385, 582). */
function resultName(j: RecordResult): string | null {
  const r = j as Partial<RecordResult> & { name?: string };
  return r.filename || r.name || null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

export default function RecordPanel() {
  const queryClient = useQueryClient();
  const runClean = useCleanRun();

  const [device, setDevice] = useState('');
  const [duration, setDuration] = useState(6);
  const [name, setName] = useState('');
  const [testing, setTesting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [startSeconds, setStartSeconds] = useState(0);
  const [levels, setLevels] = useState<Levels | null>(null);
  const tickRef = useRef<number | null>(null);

  const devicesQuery = useQuery({ queryKey: ['devices'], queryFn: api.devices });

  /* Polaris-like (8+ ch) devices first (app.js:236). */
  const devices = useMemo(() => {
    const list = devicesQuery.data?.devices ? [...devicesQuery.data.devices] : [];
    list.sort((a, b) => Number(b.is_polaris_like) - Number(a.is_polaris_like));
    return list;
  }, [devicesQuery.data]);

  /* Auto-select the first Polaris-compatible device on every (re)scan
     (app.js:244-246 — loadDevices re-picks each time it runs). */
  useEffect(() => {
    if (!devices.length) return;
    const first = devices.find((d) => d.is_polaris_like) ?? devices[0];
    if (first) setDevice(String(first.index));
  }, [devices]);

  const stopTick = (): void => {
    if (tickRef.current != null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  /* Clear the countdown if the drawer unmounts mid-record. */
  useEffect(() => stopTick, []);

  const deviceIndex = (): number | null => {
    if (device === '') return null;
    const n = Number(device);
    return Number.isFinite(n) ? n : null;
  };

  const selected = devices.find((d) => String(d.index) === device);
  const loadError = devicesQuery.isError ? errMsg(devicesQuery.error) : null;

  /* validateSelectedDevice (app.js:255-267) — inline warning when the chosen
     device exposes fewer than the required 8 input channels. */
  const channelWarn = selected && selected.max_input_ch < REQUIRED_CH ? selected.max_input_ch : null;

  const runPreflight = async (): Promise<void> => {
    if (recording || testing) return;
    setTesting(true);
    setLevels((lv) => lv ?? { peak: [], rms: [], warnings: [] }); // reveal the block
    try {
      const j = await api.preflight({ device: deviceIndex() });
      setLevels({ peak: j.per_ch_peak_db || [], rms: j.per_ch_rms_db || [], warnings: j.warnings || [] });
      toast('Preflight done - check channel levels');
    } catch (err) {
      setLevels({ peak: [], rms: [], warnings: [] });
      toast(errMsg(err) || 'Preflight failed', 'error');
    } finally {
      setTesting(false);
    }
  };

  const runRecord = async (): Promise<void> => {
    if (recording) return;
    if (!useSession.getState().acquire('recording')) return;
    setRecording(true);
    const seconds = duration;
    const fname = name.trim() || `rec_${Date.now()}.wav`;
    setStartSeconds(seconds);
    setRemaining(seconds);
    tickRef.current = window.setInterval(() => {
      setRemaining((r) => (r != null && r > 0 ? r - 1 : r));
    }, 1000);
    let didProcess = false;
    try {
      const j = await api.recordAudio({ device: deviceIndex(), seconds, filename: fname });
      stopTick();
      // Surface captured signal levels (app.js:366-369)
      if (j.per_ch_peak_db && j.per_ch_rms_db) {
        setLevels({ peak: j.per_ch_peak_db, rms: j.per_ch_rms_db, warnings: j.warnings || [] });
      }
      const savedName = resultName(j) || fname;
      // Refuse to analyse silence (app.js:370-383)
      const peakDbfs = j.peak_dbfs ?? -120;
      if (peakDbfs < -70) {
        toast(
          `Recording is silent (peak ${peakDbfs.toFixed(0)} dBFS). The file was saved as "${savedName}" but won't be analysed.\n\n` +
            'Likely causes:\n' +
            '- sensiBel kit not powered or not connected\n' +
            '- Wrong input device selected (your sensiBel shows as "Digital Audio Interface (SB-POL...)")\n' +
            '- Windows input level muted or at 0 in Sound settings\n' +
            '- OS-level mic privacy blocking access',
          'error',
        );
        void queryClient.invalidateQueries({ queryKey: ['files'] });
        return;
      }
      toast(
        `Recorded ${savedName} / peak ${peakDbfs.toFixed(0)} dBFS, gain +${(j.gain_applied_db || 0).toFixed(0)} dB applied`,
      );
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      // Hand off to the clean run - release the lock first so it can re-acquire
      // (app.js:387-393).
      didProcess = true;
      setRecording(false);
      setRemaining(null);
      useSession.getState().release();
      await runClean(savedName);
    } catch (err) {
      console.error('[runRecord]', err);
      stopTick();
      toast(`Recording error: ${errMsg(err)}`, 'error');
    } finally {
      stopTick();
      if (!didProcess) {
        setRecording(false);
        setRemaining(null);
        useSession.getState().release();
      }
    }
  };

  const recordLabel = recording
    ? remaining === startSeconds
      ? `REC / ${remaining}s`
      : `REC / ${remaining ?? 0}s remaining`
    : 'Record & clean';

  return (
    <div className="cap-stack">
      <div className="cap-row">
        <div className="cap-grow">
          <label className="cap-lab" htmlFor="cap-device">Input device</label>
          <select
            id="cap-device"
            className="cap-inp"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
          >
            {devicesQuery.isPending && <option value="">Loading...</option>}
            {loadError != null && <option value="">{loadError || 'Recording unavailable'}</option>}
            {devicesQuery.isSuccess && devices.length === 0 && (
              <option value="">No input devices found</option>
            )}
            {devices.map((d) => (
              <option key={d.index} value={String(d.index)}>
                {d.is_polaris_like ? 'OK' : 'WARN'} #{d.index} / {d.name} -{' '}
                {d.is_polaris_like ? 'Polaris-compatible' : `only ${d.max_input_ch} ch`}
              </option>
            ))}
          </select>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ['devices'] })}
        >
          Rescan
        </button>
      </div>

      <div className="cap-grid">
        <div>
          <span className="cap-lab">Channels</span>
          <div className="cap-stat">{REQUIRED_CH}</div>
        </div>
        <div>
          <span className="cap-lab">Sample rate</span>
          <div className="cap-stat">{REQUIRED_SR / 1000} kHz</div>
        </div>
        <div>
          <label className="cap-lab" htmlFor="cap-rec-dur">
            Duration <span className="cap-lab-val">{duration} s</span>
          </label>
          <input
            id="cap-rec-dur"
            className="cap-slider"
            type="range"
            min={2}
            max={30}
            step={1}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </div>
        <div>
          <label className="cap-lab" htmlFor="cap-rec-name">Filename</label>
          <input
            id="cap-rec-name"
            className="cap-inp"
            type="text"
            placeholder="rec_auto"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      {levels != null && (
        <LevelMeters peakDb={levels.peak} rmsDb={levels.rms} warnings={levels.warnings} />
      )}

      {(loadError != null || channelWarn != null) && (
        <div className="cap-device-warn" role="alert">
          {loadError != null ? (
            loadError || 'Cannot enumerate input devices'
          ) : (
            <>
              <b>This device exposes only {channelWarn} channels.</b> OCTOVOX needs all{' '}
              {REQUIRED_CH} channels of your sensiBel SB-POLARIS array. Select a device that
              exposes 8 inputs.
            </>
          )}
        </div>
      )}

      <div className="cap-actions">
        <button className="btn btn-ghost" disabled={testing} onClick={() => void runPreflight()}>
          {testing ? 'Testing...' : 'Test mics (0.3 s)'}
        </button>
        <button
          className={`btn btn-primary${recording ? ' recording' : ''}`}
          onClick={() => void runRecord()}
        >
          <span className="cap-rec-dot" />
          {recordLabel}
        </button>
      </div>
    </div>
  );
}
