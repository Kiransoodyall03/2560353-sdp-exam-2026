// Battery drain forecast per site, shown against the sample interval that drives it. A site sampling every
// 10 s wakes its instruments far more often than one at 600 s, and the server measures that as the slope of
// battery_v against time; this panel turns the slope into "hours until the pack crosses battery.min_v" so the
// operator can see which sites a Storm-watch preset will run flat first.
import type { BatteryForecast as Forecast } from '../../lib/lwm';

export interface BatteryRow {
  id: string;
  intervalS: number | null;
  online: boolean;
  battery: Forecast;
}

/** A 12 V pack's usable window: the bar runs from the alert minimum up to a nominal full charge. */
const FULL_V = 13.0;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function fmtHours(h: number | null): string {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export function BatteryForecast({ sites }: { sites: BatteryRow[] }) {
  if (sites.length === 0) return <p className="muted small">No sites yet.</p>;
  return (
    <div className="battery-forecast">
      <ul className="plain batt-list">
        {sites.map((s) => {
          const b = s.battery;
          const v = b.batteryV;
          const low = b.minV;
          const high = Math.max(FULL_V, (v ?? 0) + 0.5);
          const frac = v == null ? 0 : clamp01((v - low) / (high - low || 1));
          const tone = v == null ? 'idle' : v <= low ? 'bad' : b.hoursToMin != null && b.hoursToMin < 6 ? 'warn' : 'ok';
          const draining = b.drainVph != null && b.drainVph < -1e-4;
          return (
            <li key={s.id} className={`batt-row tone-${tone}`}>
              <div className="batt-head">
                <span className="mono batt-id">{s.id}</span>
                <span className="muted small">every {s.intervalS == null ? '—' : `${s.intervalS} s`}</span>
                <span className="batt-v mono">{v == null ? '—' : `${v.toFixed(2)} V`}</span>
              </div>
              <div className="batt-bar" role="img" aria-label={`${s.id} battery ${v == null ? 'unknown' : `${v.toFixed(2)} volts`}, minimum ${low} volts`}>
                <span className={`batt-fill tone-${tone}`} style={{ width: `${(frac * 100).toFixed(1)}%` }} />
              </div>
              <div className="batt-foot muted small">
                <span>
                  drain <span className="mono">{b.drainVph == null ? '—' : `${b.drainVph >= 0 ? '+' : '−'}${Math.abs(b.drainVph).toFixed(3)} V/h`}</span>
                </span>
                <span>
                  {v == null
                    ? 'no reading'
                    : draining
                      ? `≈ ${fmtHours(b.hoursToMin)} to ${low.toFixed(1)} V`
                      : v <= low
                        ? 'at or below minimum'
                        : 'flat or charging'}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        Faster sampling drains the pack sooner; the forecast is the measured drain against each site's current interval.
      </p>
    </div>
  );
}
