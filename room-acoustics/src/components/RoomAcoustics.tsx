import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import {
  MATERIAL_IDS,
  MATERIALS,
  eyring,
  axialModes,
  modesBelow,
  lowestMode,
  volume,
  auralize,
  compareRT60,
  DEFAULT_MODE_CUTOFF,
  type MaterialId,
  type MeasuredRT60Point,
  type RoomDimensions,
  type RT60Comparison,
  type RT60Point,
  type RoomMode,
  type SurfaceKey,
} from '../acoustics';

/** Colour for the measured-RT60 overlay (contrasts with the category bars). */
const MEASURED_COLOR = '#e7eef4';

/** Theme colours (kept here so the engine stays presentation-free). */
const C = {
  optimal: '#34d399',
  lively: '#f5b14b',
  reverberant: '#f06363',
  grid: 'rgba(255,255,255,0.07)',
  axis: '#6f8090',
  value: '#aebac6',
  band: 'rgba(45,212,191,0.10)',
  baseline: '#26343f',
} as const;

const AXIS_COLORS: Record<RoomMode['axis'], string> = {
  L: '#2dd4bf',
  W: '#a78bfa',
  H: '#5eb0ef',
};

/**
 * Thin React presentation layer over the acoustics engine. All computation
 * happens in the engine; this component only gathers inputs and renders the
 * results — no acoustics math lives here.
 */
export function RoomAcoustics(): ReactElement {
  const [dimensions, setDimensions] = useState<RoomDimensions>({ L: 5, W: 4, H: 3 });
  const [surfaces, setSurfaces] = useState<Record<SurfaceKey, MaterialId>>({
    floor: 'carpet',
    ceiling: 'ceilingTile',
    walls: 'drywall',
  });

  // Recompute on any input change. Guarded so an invalid intermediate value
  // (e.g. a cleared field) renders a message instead of throwing.
  const model = useMemo(() => {
    try {
      const rt60 = eyring(dimensions, surfaces);
      const modes = axialModes(dimensions);
      return {
        ok: true as const,
        rt60,
        modes,
        roomVolume: volume(dimensions),
        lowest: lowestMode(modes),
        rt500: rt60.find((p) => p.band === 500)?.rt60 ?? Number.NaN,
      };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : 'Invalid room' };
    }
  }, [dimensions, surfaces]);

  const audioRef = useRef<AudioContext | null>(null);
  const [playing, setPlaying] = useState(false);

  // ── Functional bridge to OCTOVOX: measure RT60 from a real recording. ──
  // `recordings === null` means the OCTOVOX API isn't reachable (e.g. standalone
  // dev) → the whole panel hides, so the app still works on its own.
  const [recordings, setRecordings] = useState<string[] | null>(null);
  const [selectedFile, setSelectedFile] = useState('');
  const [measured, setMeasured] = useState<MeasuredRT60Point[] | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measureNote, setMeasureNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/list_input');
        if (!res.ok) throw new Error(String(res.status));
        const json: { files?: Array<{ name: string }> } = await res.json();
        const names = (json.files ?? []).map((f) => f.name);
        if (!cancelled) {
          setRecordings(names);
          setSelectedFile((cur) => cur || names[0] || '');
        }
      } catch {
        if (!cancelled) setRecordings(null); // OCTOVOX not present → hide the panel
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleMeasure(): Promise<void> {
    if (!selectedFile) return;
    setMeasuring(true);
    setMeasureNote(null);
    try {
      const res = await fetch('/api/rt60', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: selectedFile }),
      });
      const json: {
        ok: boolean;
        ran?: boolean;
        bands?: Array<{ band: number; rt60: number | null }>;
        n_decays?: number;
        error?: string;
      } = await res.json();
      if (!json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (!json.ran || !json.bands) {
        setMeasured(null);
        setMeasureNote('No reliable decays found — the recording may lack speech pauses or reverb.');
        return;
      }
      setMeasured(json.bands.map((b) => ({ band: b.band, rt60: b.rt60 })));
      setMeasureNote(`Measured from ${json.n_decays ?? 0} detected decays (blind estimate).`);
    } catch (error) {
      setMeasured(null);
      setMeasureNote(`Measurement failed: ${error instanceof Error ? error.message : 'unknown'}`);
    } finally {
      setMeasuring(false);
    }
  }

  const comparison = model.ok && measured ? compareRT60(model.rt60, measured) : null;

  const setDim = (axis: keyof RoomDimensions) => (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number.parseFloat(event.target.value);
    setDimensions((prev) => ({ ...prev, [axis]: value }));
  };

  const setSurface = (key: SurfaceKey) => (event: ChangeEvent<HTMLSelectElement>) => {
    setSurfaces((prev) => ({ ...prev, [key]: event.target.value as MaterialId }));
  };

  async function handleAuralize(): Promise<void> {
    if (!model.ok || !Number.isFinite(model.rt500) || model.rt500 <= 0) return;
    let context = audioRef.current;
    if (!context) {
      context = new AudioContext();
      audioRef.current = context;
    }
    setPlaying(true);
    try {
      await auralize(context, model.rt500);
    } finally {
      setPlaying(false);
    }
  }

  const dimLabels: Record<keyof RoomDimensions, string> = { L: 'Length', W: 'Width', H: 'Height' };

  return (
    <div className="app">
      <a className="back" href="/">
        ↩ OCTOVOX console
      </a>

      <header className="hero">
        <h1 className="title">
          Room Acoustics <span className="title-accent">Estimator</span>
        </h1>
        <p className="lede">
          RT60 (Eyring) and axial room modes from room geometry and surface materials. A statistical
          estimate for shoebox rooms — see the <code>README</code> limitations.
        </p>
      </header>

      <section className="panel controls">
        <div>
          <h2 className="ctl-title">Dimensions</h2>
          {(['L', 'W', 'H'] as const).map((axis) => (
            <label key={axis} className="field">
              <span>{dimLabels[axis]}</span>
              <span className="input-wrap">
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={Number.isFinite(dimensions[axis]) ? dimensions[axis] : ''}
                  onChange={setDim(axis)}
                />
                <span className="unit">m</span>
              </span>
            </label>
          ))}
        </div>

        <div>
          <h2 className="ctl-title">Surfaces</h2>
          {(['floor', 'ceiling', 'walls'] as const).map((key) => (
            <label key={key} className="field">
              <span>{key}</span>
              <select value={surfaces[key]} onChange={setSurface(key)}>
                {MATERIAL_IDS.map((id) => (
                  <option key={id} value={id}>
                    {MATERIALS[id].name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      {!model.ok ? (
        <p className="error">{model.message}</p>
      ) : (
        <>
          <section className="metrics">
            <Metric
              label="RT60 @ 500 Hz"
              value={`${model.rt500.toFixed(2)} s`}
              sub={categoryFor(model.rt500).label}
              accent={categoryFor(model.rt500).color}
            />
            <Metric label="Room volume" value={`${model.roomVolume.toFixed(1)} m³`} accent={AXIS_COLORS.W} />
            <Metric
              label="Lowest mode"
              value={model.lowest ? `${model.lowest.freq.toFixed(1)} Hz` : '—'}
              sub={model.lowest ? `axis ${model.lowest.axis}` : undefined}
              accent={AXIS_COLORS.H}
            />
            <button type="button" className="btn-auralize" onClick={handleAuralize} disabled={playing}>
              {playing ? 'Auralizing…' : '▶ Auralize'}
            </button>
          </section>

          <section className="panel">
            <div className="panel-head">
              <span className="panel-title">RT60 vs frequency</span>
              <Legend measured={measured !== null} />
            </div>
            <Rt60Chart data={model.rt60} measured={measured} />

            {recordings !== null && (
              <div className="measure-row">
                <span className="measure-label">Compare with a recording</span>
                <select
                  value={selectedFile}
                  onChange={(e) => setSelectedFile(e.target.value)}
                  disabled={recordings.length === 0 || measuring}
                >
                  {recordings.length === 0 ? (
                    <option value="">no recordings in OCTOVOX</option>
                  ) : (
                    recordings.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  className="btn-measure"
                  onClick={handleMeasure}
                  disabled={!selectedFile || measuring}
                >
                  {measuring ? 'Measuring…' : 'Measure RT60'}
                </button>
                {measured !== null && (
                  <button
                    type="button"
                    className="btn-clear"
                    onClick={() => {
                      setMeasured(null);
                      setMeasureNote(null);
                    }}
                  >
                    clear
                  </button>
                )}
              </div>
            )}
            {measureNote ? <p className="measure-note">{measureNote}</p> : null}
            {comparison ? <ComparisonStrip rows={comparison} /> : null}
          </section>

          <section className="panel">
            <div className="panel-head">
              <span className="panel-title">Axial modes</span>
            </div>
            <ModesChart modes={model.modes} />
          </section>
        </>
      )}

      <p className="foot">Room Acoustics Estimator · part of the OCTOVOX toolkit</p>
    </div>
  );
}

/* ───────────────────────── presentational helpers ───────────────────────── */

/** RT60 quality band per the spec: optimal / lively / reverberant. */
function categoryFor(rt60: number): { label: string; color: string } {
  if (rt60 < 0.8) return { label: 'optimal', color: C.optimal };
  if (rt60 < 1.2) return { label: 'lively', color: C.lively };
  return { label: 'reverberant', color: C.reverberant };
}

function Metric(props: { label: string; value: string; sub?: string; accent?: string }): ReactElement {
  const accent = props.accent ?? C.optimal;
  return (
    <div className="metric" style={{ borderLeftColor: accent }}>
      <div className="metric-label">{props.label}</div>
      <div className="metric-value" style={{ color: accent }}>
        {props.value}
      </div>
      {props.sub ? <div className="metric-sub">{props.sub}</div> : null}
    </div>
  );
}

function Rt60Chart({
  data,
  measured,
}: {
  data: readonly RT60Point[];
  measured?: readonly MeasuredRT60Point[] | null;
}): ReactElement {
  const width = 760;
  const height = 240;
  const pad = 40;
  const measuredVals = (measured ?? []).map((m) => m.rt60).filter((v): v is number => v !== null);
  const max = Math.max(1.5, ...data.map((d) => d.rt60), ...measuredVals);
  const bandWidth = (width - pad * 2) / data.length;
  const centerX = (i: number): number => pad + i * bandWidth + bandWidth / 2;
  const yOf = (rt: number): number => height - pad - Math.min(1, rt / max) * (height - pad * 2);

  // Measured overlay: a polyline + dots at each band centre (gaps for nulls).
  const measuredByBand = new Map((measured ?? []).map((m) => [m.band, m.rt60]));
  const points = data
    .map((d, i) => {
      const m = measuredByBand.get(d.band);
      return m === null || m === undefined ? null : { x: centerX(i), y: yOf(m), m };
    })
    .filter((p): p is { x: number; y: number; m: number } => p !== null);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" role="img" aria-label="RT60 by octave band">
      {[0, 0.4, 0.8, 1.2, 1.6, 2.0]
        .filter((t) => t <= max)
        .map((tick) => {
          const y = height - pad - (tick / max) * (height - pad * 2);
          return (
            <g key={tick}>
              <line x1={pad} y1={y} x2={width - pad} y2={y} stroke={C.grid} />
              <text x={pad - 8} y={y + 4} textAnchor="end" fontSize={11} fill={C.axis}>
                {tick.toFixed(1)}
              </text>
            </g>
          );
        })}
      {data.map((d, i) => {
        const y = yOf(d.rt60);
        const x = pad + i * bandWidth;
        const color = categoryFor(d.rt60).color;
        const barHeight = height - pad - y;
        return (
          <g key={d.band}>
            <rect x={x + 7} y={y} width={bandWidth - 14} height={barHeight} rx={3} fill={color} opacity={0.9} />
            <rect x={x + 7} y={y} width={bandWidth - 14} height={Math.min(4, barHeight)} rx={3} fill="#fff" opacity={0.18} />
            <text x={x + bandWidth / 2} y={height - pad + 16} textAnchor="middle" fontSize={11} fill={C.axis}>
              {d.band}
            </text>
            <text x={x + bandWidth / 2} y={y - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill={C.value}>
              {d.rt60.toFixed(2)}
            </text>
          </g>
        );
      })}
      {points.length > 1 ? (
        <polyline
          points={points.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke={MEASURED_COLOR}
          strokeWidth={2}
          strokeDasharray="5 4"
          opacity={0.9}
        />
      ) : null}
      {points.map((p) => (
        <circle key={p.x} cx={p.x} cy={p.y} r={4} fill={MEASURED_COLOR} stroke="#0c1318" strokeWidth={1.5} />
      ))}
      <text x={width / 2} y={height - 6} textAnchor="middle" fontSize={11} fill={C.axis}>
        Octave band (Hz)
      </text>
    </svg>
  );
}

function ComparisonStrip({ rows }: { rows: readonly RT60Comparison[] }): ReactElement {
  const deltaColor = (delta: number | null): string => {
    if (delta === null) return C.axis;
    const a = Math.abs(delta);
    if (a < 0.1) return C.optimal;
    if (a < 0.25) return C.lively;
    return C.reverberant;
  };
  return (
    <div className="cmp">
      <div className="cmp-head">
        Predicted vs measured · <span style={{ color: MEASURED_COLOR }}>○ measured</span> overlaid above
      </div>
      <div className="cmp-grid">
        {rows.map((r) => (
          <div key={r.band} className="cmp-cell">
            <div className="cmp-band">{r.band} Hz</div>
            <div className="cmp-vals">
              <span title="predicted">{r.predicted.toFixed(2)}</span>
              <span className="cmp-sep">→</span>
              <span title="measured" style={{ color: MEASURED_COLOR }}>
                {r.measured === null ? '—' : r.measured.toFixed(2)}
              </span>
            </div>
            <div className="cmp-delta" style={{ color: deltaColor(r.deltaSec) }}>
              {r.deltaSec === null ? 'n/a' : `${r.deltaSec >= 0 ? '+' : ''}${r.deltaSec.toFixed(2)} s`}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModesChart({ modes }: { modes: readonly RoomMode[] }): ReactElement {
  const width = 760;
  const height = 180;
  const pad = 40;
  const maxFreq = Math.max(DEFAULT_MODE_CUTOFF, ...modes.map((m) => m.freq));
  const x = (freq: number): number => pad + (freq / maxFreq) * (width - pad * 2);
  const lowFreq = modesBelow(modes, DEFAULT_MODE_CUTOFF);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" role="img" aria-label="Axial mode frequencies">
      <rect x={pad} y={pad} width={x(DEFAULT_MODE_CUTOFF) - pad} height={height - pad * 2} fill={C.band} rx={4} />
      <text x={pad + 6} y={pad + 14} fontSize={10} fill={C.axis}>
        &lt; {DEFAULT_MODE_CUTOFF} Hz · bass-buildup zone
      </text>
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke={C.baseline} />
      {modes.map((m, i) => {
        const mx = x(m.freq);
        return (
          <g key={`${m.axis}-${m.freq.toFixed(2)}-${i}`}>
            <line x1={mx} y1={pad} x2={mx} y2={height - pad} stroke={AXIS_COLORS[m.axis]} strokeWidth={2} opacity={0.8} />
            <circle cx={mx} cy={pad} r={3.5} fill={AXIS_COLORS[m.axis]} />
          </g>
        );
      })}
      {[0, 0.25, 0.5, 0.75, 1].map((frac) => (
        <text
          key={frac}
          x={pad + frac * (width - pad * 2)}
          y={height - pad + 17}
          textAnchor="middle"
          fontSize={11}
          fill={C.axis}
        >
          {Math.round(frac * maxFreq)}
        </text>
      ))}
      <text x={width / 2} y={height - 4} textAnchor="middle" fontSize={11} fill={C.axis}>
        Frequency (Hz) — {lowFreq.length} mode{lowFreq.length === 1 ? '' : 's'} below {DEFAULT_MODE_CUTOFF} Hz
      </text>
      {(Object.keys(AXIS_COLORS) as RoomMode['axis'][]).map((axis, i) => (
        <g key={axis} transform={`translate(${width - pad - 96 + i * 34}, ${pad - 6})`}>
          <rect width={10} height={10} fill={AXIS_COLORS[axis]} rx={2} />
          <text x={14} y={9} fontSize={11} fill={C.value}>
            {axis}
          </text>
        </g>
      ))}
    </svg>
  );
}

function Legend({ measured = false }: { measured?: boolean }): ReactElement {
  const items = [
    { label: '< 0.8 s optimal', color: C.optimal },
    { label: '< 1.2 s lively', color: C.lively },
    { label: '≥ 1.2 s reverberant', color: C.reverberant },
  ];
  return (
    <div className="legend">
      {items.map((item) => (
        <span key={item.label} className="legend-item">
          <span className="legend-swatch" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
      {measured ? (
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: MEASURED_COLOR, borderRadius: '50%' }} />
          measured
        </span>
      ) : null}
    </div>
  );
}
