// Wind rose: 16 direction bins as petals around a compass, radius weighted by how hard the wind blew from
// that direction (sum of wind_speed_ms), colour by the mean speed in the bin. Pure SVG so it stays crisp at
// any size and reads well next to the site cards. The bins come from the server (plugins/lwm/derive.ts).
import type { WindRoseBin } from '../../lib/lwm';

const SIZE = 240;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R_MAX = SIZE / 2 - 26;

/** North-up polar → SVG cartesian. */
function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

/** Sequential blue→amber by mean speed fraction, matching the map ramp's feel. */
function speedColour(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  const r = Math.round(60 + x * 195);
  const g = Math.round(120 + x * 60);
  const b = Math.round(200 - x * 150);
  return `rgb(${r}, ${g}, ${b})`;
}

export function WindRose({ bins, label = 'Wind rose' }: { bins: WindRoseBin[]; label?: string }) {
  const maxSum = Math.max(1, ...bins.map((b) => b.sumSpeedMs));
  const maxMean = Math.max(1e-6, ...bins.map((b) => b.meanSpeedMs ?? 0));
  const rings = [0.25, 0.5, 0.75, 1];
  const any = bins.some((b) => b.count > 0);

  // prevailing = the bin carrying the most wind speed
  let prevailing: WindRoseBin | null = null;
  for (const b of bins) if (b.sumSpeedMs > 0 && (!prevailing || b.sumSpeedMs > prevailing.sumSpeedMs)) prevailing = b;

  return (
    <div className="wind-rose">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={label} className="rose-svg">
        {/* rings */}
        {rings.map((f) => (
          <circle key={f} cx={CX} cy={CY} r={R_MAX * f} fill="none" stroke="var(--line)" strokeWidth={1} />
        ))}
        {/* spokes + compass labels */}
        {bins.map((b) => {
          const [x, y] = polar(b.deg, R_MAX);
          return <line key={`s-${b.deg}`} x1={CX} y1={CY} x2={x} y2={y} stroke="var(--line)" strokeWidth={0.5} />;
        })}
        {(['N', 'E', 'S', 'W'] as const).map((c, i) => {
          const [x, y] = polar(i * 90, R_MAX + 15);
          return (
            <text key={c} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="rose-label">
              {c}
            </text>
          );
        })}
        {/* petals */}
        {any &&
          bins.map((b) => {
            if (b.sumSpeedMs <= 0) return null;
            const r = (b.sumSpeedMs / maxSum) * R_MAX;
            const a0 = b.deg - 11.25;
            const a1 = b.deg + 11.25;
            const [x0, y0] = polar(a0, r);
            const [x1, y1] = polar(a1, r);
            const d = `M ${CX} ${CY} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
            const mean = b.meanSpeedMs ?? 0;
            return (
              <path
                key={`p-${b.deg}`}
                d={d}
                fill={speedColour(mean / maxMean)}
                fillOpacity={0.72}
                stroke="rgba(13,17,23,0.6)"
                strokeWidth={0.5}
              >
                <title>{`${b.label}: ${b.count} samples, mean ${mean.toFixed(1)} m/s`}</title>
              </path>
            );
          })}
        <circle cx={CX} cy={CY} r={2} fill="var(--muted)" />
        {!any && (
          <text x={CX} y={CY} textAnchor="middle" dominantBaseline="middle" className="rose-empty">
            no wind yet
          </text>
        )}
      </svg>
      <p className="muted small rose-note">
        {prevailing
          ? `Prevailing from ${prevailing.label} (${prevailing.meanSpeedMs?.toFixed(1) ?? '—'} m/s mean).`
          : 'Waiting for wind samples.'}
      </p>
    </div>
  );
}
