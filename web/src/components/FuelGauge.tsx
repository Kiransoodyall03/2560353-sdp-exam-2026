// Diesel tank: a vertical bar with the 2 % start limit and a tick for every delivery the plant reported,
// so "48 % left" can be read against how often and how much it has been refuelled.
import { fmtTime, fmtNum } from '../lib/format';

const H = 190;
const MIN_PCT = 2;

export interface RefuelMark {
  ts: number;
  litres: number | null;
  fuelPct: number | null;
}

export function FuelGauge({
  fuelPct,
  litres,
  tankL,
  burnLph,
  hoursLeftH,
  refuels,
}: {
  fuelPct: number | null;
  litres: number | null;
  tankL: number;
  burnLph: number | null;
  hoursLeftH: number | null;
  refuels: RefuelMark[];
}) {
  const level = fuelPct ?? 0;
  const tone = fuelPct === null ? 'idle' : fuelPct < MIN_PCT ? 'bad' : fuelPct < 25 ? 'warn' : 'ok';
  const colour = tone === 'bad' ? '#e05c5c' : tone === 'warn' ? '#e0a33c' : '#6fcf7f';
  const marks = refuels.slice(-8);

  return (
    <div className={`gauge tone-${tone}`}>
      <div className="fuel-row">
        <svg viewBox={`0 0 84 ${H}`} role="img" aria-label={`Diesel tank at ${fmtNum(fuelPct, 1)} %`}>
          <rect x="8" y="0" width="34" height={H} rx="4" fill="#1a2029" stroke="#232a34" />
          <rect x="8" y={H - (H * level) / 100} width="34" height={(H * level) / 100} fill={colour} opacity="0.85" />
          {/* the level below which the service refuses a start */}
          <line x1="4" x2="52" y1={H - (H * MIN_PCT) / 100} y2={H - (H * MIN_PCT) / 100} stroke="#e05c5c" strokeWidth={1.5} strokeDasharray="3 2" />
          <text x="54" y={H - (H * MIN_PCT) / 100 + 4} className="gauge-tick-label">
            2 %
          </text>
          {marks.map((r) => {
            const y = H - (H * (r.fuelPct ?? 0)) / 100;
            return (
              <g key={r.ts}>
                <line x1="42" x2="50" y1={y} y2={y} stroke="#4cc9f0" strokeWidth={2} />
                <circle cx="46" cy={y} r="2.5" fill="#4cc9f0" />
              </g>
            );
          })}
        </svg>
        <div className="fuel-readout">
          <div className="gauge-value">
            {fmtNum(fuelPct, 0)}
            <span className="gauge-unit"> %</span>
          </div>
          <div className="muted small">{litres === null ? '—' : `${fmtNum(litres, 0)} of ${fmtNum(tankL, 0)} L`}</div>
          <div className="small">
            {hoursLeftH === null ? (
              <span className="muted">generators off</span>
            ) : (
              <>
                <strong>{fmtNum(hoursLeftH, 1)} h</strong> left at {fmtNum(burnLph, 1)} L/h
              </>
            )}
          </div>
          {marks.length > 0 && (
            <ul className="refuel-list small">
              {marks
                .slice()
                .reverse()
                .map((r) => (
                  <li key={r.ts}>
                    <span className="refuel-dot" aria-hidden="true" /> {r.litres === null ? 'delivery' : `${fmtNum(r.litres, 0)} L`} at {fmtTime(r.ts)}
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
