import { useMemo, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import {
  MATERIAL_IDS,
  MATERIALS,
  eyring,
  axialModes,
  modesBelow,
  lowestMode,
  volume,
  auralize,
  DEFAULT_MODE_CUTOFF,
  type MaterialId,
  type RoomDimensions,
  type RT60Point,
  type RoomMode,
  type SurfaceKey,
} from '../acoustics';

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
              <Legend />
            </div>
            <Rt60Chart data={model.rt60} />
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

function Rt60Chart({ data }: { data: readonly RT60Point[] }): ReactElement {
  const width = 760;
  const height = 240;
  const pad = 40;
  const max = Math.max(1.5, ...data.map((d) => d.rt60));
  const bandWidth = (width - pad * 2) / data.length;
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
        const barHeight = Math.min(1, d.rt60 / max) * (height - pad * 2);
        const x = pad + i * bandWidth;
        const y = height - pad - barHeight;
        const color = categoryFor(d.rt60).color;
        return (
          <g key={d.band}>
            <rect x={x + 7} y={y} width={bandWidth - 14} height={barHeight} rx={3} fill={color} opacity={0.92} />
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
      <text x={width / 2} y={height - 6} textAnchor="middle" fontSize={11} fill={C.axis}>
        Octave band (Hz)
      </text>
    </svg>
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

function Legend(): ReactElement {
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
    </div>
  );
}
