// Diesel tank: a flat level bar with the 2 % start limit marked and a tick for every delivery the plant
// reported, so "48 % left" can be read against how often and how much it has been refuelled.
import { fmtNum, fmtTime } from '../lib/format';
import { SeverityBadge } from './ui';

/** Below this the service refuses a start. */
const START_LIMIT_PCT = 2;
/** Warn well before the start limit, so a refuel can still be planned. */
const LOW_PCT = 25;

export interface RefuelMark {
  ts: number;
  litres: number | null;
  fuelPct: number | null;
}

const clamp = (v: number) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);

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
  const level = clamp(fuelPct ?? 0);
  const belowStart = fuelPct !== null && fuelPct < START_LIMIT_PCT;
  const low = fuelPct !== null && fuelPct < LOW_PCT;
  const marks = refuels.slice(-8);

  return (
    <div className={`gauge${low ? ' limit-low' : ''}`}>
      <div className="reading-head">
        <span className="arl-label">Diesel tank</span>
        {belowStart && <SeverityBadge severity="critical">Below start limit</SeverityBadge>}
        {!belowStart && low && <SeverityBadge severity="warning">Low fuel</SeverityBadge>}
      </div>
      <div className="arl-reading">
        {fmtNum(fuelPct, 0)}
        {fuelPct !== null && <small>%</small>}
      </div>
      <div
        className="arl-limit gauge-track"
        role="img"
        aria-label={`Diesel at ${fmtNum(fuelPct, 1)} %, start limit ${START_LIMIT_PCT} %`}
        title={`Start limit ${START_LIMIT_PCT} %`}
      >
        <span className="arl-limit__fill" style={{ width: `${level}%` }} />
        <span className="arl-limit__mark" style={{ left: `calc(${START_LIMIT_PCT}% - 1px)` }} />
        {marks.map((r) =>
          r.fuelPct == null ? null : (
            <span
              key={r.ts}
              className="limit-tick"
              style={{ left: `${clamp(r.fuelPct)}%` }}
              title={`${r.litres === null ? 'Delivery' : `${fmtNum(r.litres, 0)} L`} at ${fmtTime(r.ts)}`}
            />
          ),
        )}
      </div>
      <p className="reading-cause">
        {litres === null ? 'Level unknown' : `${fmtNum(litres, 0)} of ${fmtNum(tankL, 0)} L`}
        {hoursLeftH === null
          ? ' · generators off'
          : ` · ${fmtNum(hoursLeftH, 1)} h left at ${fmtNum(burnLph, 1)} L/h`}
      </p>
      {marks.length > 0 && (
        <ul className="refuel-list small">
          {marks
            .slice()
            .reverse()
            .map((r) => (
              <li key={r.ts}>
                <span className="refuel-dot" aria-hidden="true" />{' '}
                {r.litres === null ? 'Delivery' : `${fmtNum(r.litres, 0)} L`} at {fmtTime(r.ts)}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
