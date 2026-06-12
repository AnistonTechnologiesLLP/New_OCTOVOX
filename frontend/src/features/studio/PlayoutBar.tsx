/* Playout bar — output-device picker + "Play to device", porting
   loadOutputDevices (app.js:1935-1949) and playToDevice (app.js:1951-1966):
   "Default output" (value "") first, devices as "Name (Nch)" with the
   backend default pre-selected once, every failure path degrading to just
   the default option, and the legacy success/failure toast copy. */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../state/toasts';

export default function PlayoutBar({ stem }: { stem: string }) {
  // api.devicesOut throws on !ok / HTTP failure → data stays undefined and
  // the select degrades to "Default output" only, matching legacy fallbacks.
  const devices = useQuery({ queryKey: ['devicesOut'], queryFn: api.devicesOut });
  const [device, setDevice] = useState('');
  const [pending, setPending] = useState(false);
  const preselected = useRef(false);

  // Pre-select the backend default exactly once (app.js:1942-1945) — later
  // refetches must not clobber a user's choice.
  useEffect(() => {
    if (preselected.current) return;
    const list = devices.data?.devices;
    if (!list) return;
    preselected.current = true;
    const def = list.find((d) => d.is_default);
    if (def) setDevice(String(def.index));
  }, [devices.data]);

  const playTo = async (): Promise<void> => {
    if (!stem) return;
    const dev = device !== '' ? device : null;
    setPending(true);
    try {
      const j = await api.playout(stem, dev);
      toast(
        `Playing clean output to device${dev != null ? ` #${dev}` : ' (default)'} / ${j.duration_s}s`,
      );
    } catch (err) {
      toast(`Playout failed: ${err instanceof Error ? err.message : 'unknown error'}`, 'error');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="card playout-bar" aria-label="Playout">
      <span className="playout-lab">Playout</span>
      <select
        className="inp playout-select"
        aria-label="Output device"
        value={device}
        onChange={(e) => setDevice(e.target.value)}
      >
        <option value="">Default output</option>
        {(devices.data?.devices ?? []).map((d) => (
          <option key={d.index} value={String(d.index)}>
            {d.name} ({d.max_output_ch}ch)
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn"
        disabled={pending}
        title="Play the clean WAV out of the selected device"
        onClick={() => void playTo()}
      >
        Play to device
      </button>
    </section>
  );
}
