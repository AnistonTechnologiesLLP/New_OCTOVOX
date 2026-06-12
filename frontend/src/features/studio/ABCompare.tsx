/* Level-matched A/B compare — ports loadABPlayers + setupABCompare + the `A`
   key flip (app.js:1721-1881) on top of useWaveSurfer + abEngine.

   Engine choreography (verbatim from legacy):
   - side defaults to "clean"; only the selected side is audible (other at 0)
   - gains recomputed on each player's `ready` from the decoded buffers
   - A/B Play starts BOTH players from the ACTIVE player's current time so a
     mid-play RAW/CLEAN flip is gapless; Pause pauses both
   - flipping sides only swaps volumes — playback position is untouched
   - per-track solo Play pauses the other track; `finish` resets play state
   - `A` flips RAW/CLEAN (skipped while typing or when a modal is open)

   NEW (PORTING.md §7): per-track waveform/spectrogram toggle. Toggling (and
   theme flips) destroys + recreates that track's player, so playback is
   stopped first to keep the lock-step transport honest. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { computeABGains, rmsOfBuffer, type ABGains } from './abEngine';
import { useWaveSurfer, type WaveView } from './useWaveSurfer';
import { useModal } from '../../state/modals';

type Side = 'raw' | 'clean';

function isTypingInField(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
  );
}

interface ABCompareProps {
  inputUrl: string;
  cleanUrl: string;
  /** Track sublabels — legacy: "raw 8-ch downmix" / opts label or clean_prod.wav. */
  inputSub: string;
  cleanSub: string;
}

export default function ABCompare({ inputUrl, cleanUrl, inputSub, cleanSub }: ABCompareProps) {
  const [rawView, setRawView] = useState<WaveView>('wave');
  const [cleanView, setCleanView] = useState<WaveView>('wave');
  const { containerRef: rawRef, ws: rawWs } = useWaveSurfer(inputUrl, 'raw', rawView);
  const { containerRef: cleanRef, ws: cleanWs } = useWaveSurfer(cleanUrl, 'clean', cleanView);

  const [side, setSideState] = useState<Side>('clean'); // AB.side default (app.js:1784)
  const [abPlaying, setAbPlaying] = useState(false);
  const [solo, setSolo] = useState<Side | null>(null);
  const [loadError, setLoadError] = useState(false);

  // The audio path reads these refs so handlers stay instant and stable.
  const gainsRef = useRef<ABGains>({ rawGain: 1, cleanGain: 1 });
  const sideRef = useRef<Side>(side);
  sideRef.current = side;

  /** applyABVolumes (app.js:1799-1802): only the selected side is audible. */
  const applyABVolumes = useCallback(() => {
    const g = gainsRef.current;
    if (rawWs) rawWs.setVolume(sideRef.current === 'raw' ? g.rawGain : 0);
    if (cleanWs) cleanWs.setVolume(sideRef.current === 'clean' ? g.cleanGain : 0);
  }, [rawWs, cleanWs]);

  // New sources reset the A/B state (setupABCompare, app.js:1818).
  useEffect(() => {
    setSideState('clean');
    setAbPlaying(false);
    setSolo(null);
    setLoadError(false);
  }, [inputUrl, cleanUrl]);

  // Recompute loudness once each player has decoded its audio
  // (app.js:1820-1824). Also run immediately: a player recreated after a
  // theme/view flip has already decoded, so its `ready` won't fire again.
  useEffect(() => {
    const recompute = (): void => {
      gainsRef.current = computeABGains(
        rmsOfBuffer(rawWs ? rawWs.getDecodedData() : null),
        rmsOfBuffer(cleanWs ? cleanWs.getDecodedData() : null),
      );
      applyABVolumes();
    };
    recompute();
    const offs: Array<() => void> = [];
    if (rawWs) offs.push(rawWs.on('ready', recompute));
    if (cleanWs) offs.push(cleanWs.on('ready', recompute));
    return () => offs.forEach((off) => off());
  }, [rawWs, cleanWs, applyABVolumes]);

  // finish → reset to idle play-state (app.js:1766-1773, 1858-1861); also
  // surface decode failures (re-view of a never-cleaned file 404s).
  useEffect(() => {
    const offs: Array<() => void> = [];
    if (rawWs) {
      offs.push(
        rawWs.on('finish', () => {
          setAbPlaying(false);
          setSolo((s) => (s === 'raw' ? null : s));
        }),
      );
      offs.push(rawWs.on('error', () => setLoadError(true)));
    }
    if (cleanWs) {
      offs.push(
        cleanWs.on('finish', () => {
          setAbPlaying(false);
          setSolo((s) => (s === 'clean' ? null : s));
        }),
      );
      offs.push(cleanWs.on('error', () => setLoadError(true)));
    }
    return () => offs.forEach((off) => off());
  }, [rawWs, cleanWs]);

  // RAW/CLEAN switch (app.js:1826-1832): swap volumes immediately — the
  // instant, gapless flip is the whole point. State only restyles buttons.
  const setSide = useCallback(
    (next: Side) => {
      sideRef.current = next;
      setSideState(next);
      applyABVolumes();
    },
    [applyABVolumes],
  );

  // A/B transport (app.js:1834-1856): pausing pauses both; playing starts
  // BOTH from the active player's position so a mid-play flip is gapless.
  const onAbPlay = useCallback(() => {
    const active = sideRef.current === 'raw' ? rawWs : cleanWs;
    if (!active) return;
    const playing = active.isPlaying();
    // stop the solo per-track buttons' state from lingering
    setSolo(null);
    if (playing) {
      if (rawWs) rawWs.pause();
      if (cleanWs) cleanWs.pause();
      setAbPlaying(false);
    } else {
      // start BOTH from the active player's position so a mid-play flip is gapless
      const t = active.getCurrentTime();
      applyABVolumes();
      [rawWs, cleanWs].forEach((ws) => {
        if (!ws) return;
        try {
          ws.setTime(t);
        } catch {
          /* not decoded yet — plays from 0, matching legacy's seekTo(0) fallback */
        }
        void ws.play();
      });
      setAbPlaying(true);
    }
  }, [rawWs, cleanWs, applyABVolumes]);

  // Per-track solo Play (app.js:1748-1765): playing one pauses the other.
  // Legacy left the un-selected side muted by applyABVolumes, which made its
  // solo button play silently; here a starting solo applies that track's own
  // level-matched gain so "Play" is always audible — the next A/B action
  // re-applies the mute state via the same applyABVolumes call as legacy.
  const onSolo = useCallback(
    (which: Side) => {
      const ws = which === 'raw' ? rawWs : cleanWs;
      const other = which === 'raw' ? cleanWs : rawWs;
      if (!ws) return;
      if (other && other.isPlaying()) other.pause();
      setAbPlaying(false); // the lock-step transport is no longer driving
      const willPlay = !ws.isPlaying();
      if (willPlay) {
        const g = gainsRef.current;
        ws.setVolume(which === 'raw' ? g.rawGain : g.cleanGain);
      }
      void ws.playPause();
      setSolo(willPlay ? which : null);
    },
    [rawWs, cleanWs],
  );

  // Keyboard: `A` flips the A/B source (app.js:1870-1881). Mounted only on
  // the Studio view, so the legacy router check is inherent; typing and
  // open-modal suppression match the shell's listener pattern.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'a' && e.key !== 'A') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingInField()) return;
      if (useModal.getState().isOpen()) return;
      if (!rawWs || !cleanWs) return;
      e.preventDefault();
      setSide(sideRef.current === 'raw' ? 'clean' : 'raw');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rawWs, cleanWs, setSide]);

  // NEW: waveform/spectrogram toggle. Recreating a player mid-play would
  // desync the lock-step pair, so stop everything first.
  const toggleView = useCallback(
    (which: Side) => {
      if (rawWs) rawWs.pause();
      if (cleanWs) cleanWs.pause();
      setAbPlaying(false);
      setSolo(null);
      if (which === 'raw') setRawView((v) => (v === 'wave' ? 'spec' : 'wave'));
      else setCleanView((v) => (v === 'wave' ? 'spec' : 'wave'));
    },
    [rawWs, cleanWs],
  );

  const track = (kind: Side, sub: string, view: WaveView, ref: React.RefObject<HTMLDivElement>) => (
    <div className={`track${kind === 'clean' ? ' track-clean' : ''}`} data-kind={kind}>
      <div className="track-head">
        <span className={`track-tag track-tag-${kind}`}>{kind.toUpperCase()}</span>
        <span className="track-sub">{sub}</span>
        <button
          type="button"
          className={`track-view${view === 'spec' ? ' active' : ''}`}
          title={view === 'spec' ? 'Show the waveform' : 'Show a spectrogram'}
          aria-pressed={view === 'spec'}
          onClick={() => toggleView(kind)}
        >
          {view === 'spec' ? 'Waveform' : 'Spectrogram'}
        </button>
      </div>
      <div className="track-wave" ref={ref} />
      <button type="button" className={`track-play${solo === kind ? ' playing' : ''}`} onClick={() => onSolo(kind)}>
        {solo === kind ? 'Pause' : 'Play'}
      </button>
    </div>
  );

  return (
    <section className="card ab-card" aria-label="A/B compare">
      <div className="ab-bar">
        <button
          type="button"
          className={`ab-play${abPlaying ? ' playing' : ''}`}
          title="Play / pause the A/B comparison"
          onClick={onAbPlay}
        >
          {abPlaying ? 'Pause' : 'Play'}
        </button>
        <div className="ab-switch" role="tablist" aria-label="Compare raw vs clean">
          <button
            type="button"
            className={`ab-opt${side === 'raw' ? ' active' : ''}`}
            role="tab"
            aria-selected={side === 'raw'}
            onClick={() => setSide('raw')}
          >
            RAW
          </button>
          <button
            type="button"
            className={`ab-opt${side === 'clean' ? ' active' : ''}`}
            role="tab"
            aria-selected={side === 'clean'}
            onClick={() => setSide('clean')}
          >
            CLEAN
          </button>
        </div>
        <span className="ab-hint">
          level-matched / press <kbd>A</kbd> to flip
        </span>
      </div>

      {track('raw', inputSub, rawView, rawRef)}
      {track('clean', cleanSub, cleanView, cleanRef)}

      {loadError && (
        <div className="ab-error" role="alert">
          Couldn&apos;t load this file&apos;s audio — run a clean on it first.
        </div>
      )}
    </section>
  );
}
