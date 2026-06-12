/* WaveSurfer lifecycle hook — one instance per container, StrictMode-safe.
   Create options ported from legacy loadABPlayers (app.js:1730-1745):
   height 64, barWidth 2, barGap 1, barRadius 1 (no normalize in legacy),
   colors from the --wave-* theme tokens (themeColors, app.js:161-171).

   The instance is destroyed + recreated when the url, theme mode, or view
   changes — the legacy recolored live via setOptions (app.js:172-177);
   recreating covers that AND the NEW per-track spectrogram view with one
   code path. The spectrogram plugin is lazy-imported (separate chunk) on
   first use and registered at create time so its teardown is exactly
   WaveSurfer.destroy() — no half-removed plugin canvases. */

import { useEffect, useRef, useState } from 'react';
import WaveSurfer, { type WaveSurferOptions } from 'wavesurfer.js';
import { readCssVar, useTheme } from '../../hooks/useTheme';

export type WaveKind = 'raw' | 'clean';
export type WaveView = 'wave' | 'spec';

export interface UseWaveSurferResult {
  /** Attach to the waveform container div. */
  containerRef: React.RefObject<HTMLDivElement>;
  /** The live instance (null until created / while recreating). */
  ws: WaveSurfer | null;
}

export function useWaveSurfer(url: string | null, kind: WaveKind, view: WaveView): UseWaveSurferResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [ws, setWs] = useState<WaveSurfer | null>(null);
  const { mode } = useTheme(); // recreate (recolor) on light/dark flips

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !url) return undefined;
    let cancelled = false;

    const create = async (): Promise<void> => {
      let plugins: WaveSurferOptions['plugins'];
      if (view === 'spec') {
        // Lazy chunk: FFT/render code only loads the first time a track
        // flips to the spectrogram view.
        const { default: Spectrogram } = await import(
          'wavesurfer.js/dist/plugins/spectrogram.esm.js'
        );
        if (cancelled) return;
        plugins = [
          Spectrogram.create({
            height: 72,
            labels: false,
            scale: 'mel',
            // theme-reasonable colormaps: dark spectral ink on the light
            // theme, perceptual roseus on the dark theme
            colorMap: mode === 'dark' ? 'roseus' : 'igray',
          }),
        ];
      }
      // Ref-guard: React 18 StrictMode double-mounts effects — never leave
      // two instances on one container.
      if (cancelled || wsRef.current) return;
      const instance = WaveSurfer.create({
        container: el,
        waveColor: readCssVar(kind === 'raw' ? '--wave-raw' : '--wave-clean'),
        progressColor: readCssVar(kind === 'raw' ? '--wave-raw-prog' : '--wave-clean-prog'),
        // spec view keeps a slim waveform strip as the seek/cursor surface
        height: view === 'spec' ? 24 : 64,
        cursorColor: readCssVar('--wave-cursor'),
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        url,
        ...(plugins ? { plugins } : {}),
      });
      wsRef.current = instance;
      setWs(instance);
    };
    void create();

    return () => {
      cancelled = true;
      const instance = wsRef.current;
      wsRef.current = null;
      setWs(null);
      if (instance) {
        try {
          instance.destroy();
        } catch {
          /* already torn down */
        }
      }
    };
  }, [url, kind, view, mode]);

  return { containerRef, ws };
}
