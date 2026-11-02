// Stacked energy per hour or per day: solar, battery discharge and diesel stacked to the supplied energy,
// with the load drawn as a tick on the same column so over- and under-supply are visible at a glance.
import { fmtNum, fmtTime } from '../lib/format';
import type { OpgBucket } from '../lib/opg';

const H = 170;
const SERIES = [
  { key: 'solarKwh', label: 'Solar', colour: 'var(--ochre)' },
  { key: 'batteryOutKwh', label: 'Battery', colour: 'var(--sunset)' },
  { key: 'dieselKwh', label: 'Diesel', colour: 'var(--dust)' },
] as const;

export function GenerationChart({ buckets, mode }: { buckets: OpgBucket[]; mode: 'hour' | 'day' }) {
  if (buckets.length === 0) return <p className="muted">No supply history in this window.</p>;
  const supplied = (b: OpgBucket) => b.solarKwh + b.batteryOutKwh + b.dieselKwh;
  const max = Math.max(1, ...buckets.map((b) => Math.max(supplied(b), b.loadKwh)));
  const label = (ts: number) => (mode === 'hour' ? fmtTime(ts) : fmtTime(ts).slice(0, 5));
  // a label every n columns keeps the axis readable when the window holds a week of hours
  const every = Math.max(1, Math.ceil(buckets.length / 8));

  return (
    <div className="stack-wrap">
      <div className="stack-chart" style={{ height: H }}>
        {buckets.map((b) => (
          <div
            className="stack-col"
            key={b.ts}
            title={`${label(b.ts)} · solar ${fmtNum(b.solarKwh, 1)} kWh · battery ${fmtNum(b.batteryOutKwh, 1)} kWh · diesel ${fmtNum(
              b.dieselKwh,
              1,
            )} kWh · load ${fmtNum(b.loadKwh, 1)} kWh`}
          >
            {SERIES.map((s) => {
              const v = b[s.key];
              if (v <= 0) return null;
              return <div key={s.key} className="stack-seg" style={{ height: `${(v / max) * 100}%`, background: s.colour }} />;
            })}
            <div className="stack-load" style={{ bottom: `${(Math.max(0, b.loadKwh) / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="stack-axis small" aria-hidden="true">
        {buckets.map((b, i) => (
          <span key={b.ts}>{i % every === 0 ? label(b.ts) : ''}</span>
        ))}
      </div>
      <ul className="stack-legend small">
        {SERIES.map((s) => (
          <li key={s.key}>
            <span className="swatch" style={{ background: s.colour }} aria-hidden="true" /> {s.label}
          </li>
        ))}
        <li>
          <span className="swatch swatch-load" aria-hidden="true" /> Load
        </li>
        <li className="muted">
          {mode === 'hour' ? 'per hour' : 'per day'} · peak {fmtNum(max, 0)} kWh
        </li>
      </ul>
    </div>
  );
}
