/* Per-channel level meters — ports renderLevels (app.js:311-332): bars map
   -60..0 dB to 0..100% height (min 2%), `silent` below -80 dB peak, `clip`
   above -1 dB; per-bar `ch <i>` label + `<p> dB` readout; warnings below. */

interface LevelMetersProps {
  peakDb: number[];
  rmsDb: number[];
  warnings: string[];
}

export default function LevelMeters({ peakDb, rmsDb, warnings }: LevelMetersProps) {
  return (
    <div className="cap-levels">
      <div className="cap-levels-head">
        Channel levels <span className="muted">/ 0.3 s preflight</span>
      </div>
      {peakDb.length === 0 ? (
        <div className="cap-levels-empty muted">no data</div>
      ) : (
        <div className="cap-levels-bars">
          {peakDb.map((p, i) => {
            const pct = Math.max(2, Math.min(100, ((p + 60) / 60) * 100));
            const silent = p < -80;
            const clip = p > -1;
            const cls = `cap-level-fill${silent ? ' silent' : ''}${clip ? ' clip' : ''}`;
            const rms = rmsDb[i];
            const title =
              rms != null ? `peak ${p.toFixed(1)} dB / rms ${rms.toFixed(1)} dB` : `peak ${p.toFixed(1)} dB`;
            return (
              <div className="cap-level" key={i} title={title}>
                <div className="cap-level-num">ch {i}</div>
                <div className="cap-level-track">
                  <div className={cls} style={{ height: `${pct}%` }} />
                </div>
                <div className="cap-level-val">{p.toFixed(0)} dB</div>
              </div>
            );
          })}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="cap-levels-warn">
          {warnings.map((w, i) => (
            <div className="cap-warn-line" key={i}>{w}</div>
          ))}
        </div>
      )}
    </div>
  );
}
