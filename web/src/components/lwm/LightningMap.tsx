// Lightning map: strikes plotted by distance and bearing from the ARL centre on a north-up polar scope.
// Range rings mark the lightning.max_km (danger) and storm.approach_km (watch) alert limits, so "is the
// storm inside the safe radius" is a glance. Newer strikes are brighter; the nearest one is ringed. The
// strike list and the derived nearest/approach numbers come from the server.
import { SeverityBadge } from '../ui';
import { compassFromRad, type LightningDerived, type LwmLimits, type LwmStrike } from '../../lib/lwm';

const SIZE = 300;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R_MAX = SIZE / 2 - 30;

function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

export function LightningMap({
  strikes,
  limits,
  derived,
  label = 'Lightning strikes by distance and bearing',
}: {
  strikes: LwmStrike[];
  limits: LwmLimits;
  derived: LightningDerived | null;
  label?: string;
}) {
  const distances = strikes.map((s) => s.distanceKm).filter((d): d is number => d != null && Number.isFinite(d));
  // the scope spans at least the approach limit, or the farthest strike if that is larger
  const spanKm = Math.max(limits.stormApproachKm, limits.lightningMaxKm, ...distances, 1) * 1.1;
  const rOf = (km: number) => (km / spanKm) * R_MAX;
  const newest = strikes.length ? strikes[strikes.length - 1]!.ts : null;
  const oldest = strikes.length ? strikes[0]!.ts : null;
  const ageFrac = (ts: number) => (newest != null && oldest != null && newest > oldest ? (ts - oldest) / (newest - oldest) : 1);

  const nearestKm = derived?.nearestKm ?? null;
  const rings = [limits.lightningMaxKm, limits.stormApproachKm].filter((r) => r > 0 && r < spanKm);

  return (
    <div className="lightning-map">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={label} className="strike-svg">
        {/* range grid */}
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <circle key={f} cx={CX} cy={CY} r={R_MAX * f} fill="none" stroke="var(--line)" strokeWidth={1} />
        ))}
        {(['N', 'E', 'S', 'W'] as const).map((c, i) => {
          const [x, y] = polar(i * 90, R_MAX + 16);
          return (
            <text key={c} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="rose-label">
              {c}
            </text>
          );
        })}
        {/* alert-limit rings */}
        {rings.map((km) => (
          <g key={`ring-${km}`}>
            <circle
              cx={CX}
              cy={CY}
              r={rOf(km)}
              fill="none"
              stroke="var(--line-strong)"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
            <text x={CX + 3} y={CY - rOf(km) - 3} className="ring-label" fill="var(--ink-muted)">
              {km} km
            </text>
          </g>
        ))}
        {/* strikes: ochre, fading with age */}
        {strikes.map((s, i) => {
          if (s.distanceKm == null || s.bearingRad == null) return null;
          const deg = ((s.bearingRad * 180) / Math.PI + 360) % 360;
          const [x, y] = polar(deg, rOf(s.distanceKm));
          const isNearest = nearestKm != null && Math.abs(s.distanceKm - nearestKm) < 1e-6;
          const op = 0.3 + 0.7 * ageFrac(s.ts);
          return (
            <g key={`${s.ts}-${i}`}>
              {isNearest && <circle cx={x} cy={y} r={7} fill="none" stroke="var(--ink)" strokeWidth={1.5} />}
              <circle cx={x} cy={y} r={isNearest ? 4 : 3} fill="var(--ochre)" opacity={op}>
                <title>{`${s.distanceKm.toFixed(1)} km ${compassFromRad(s.bearingRad) ?? ''} · ${s.detectedBy.join(', ') || 'network'}`}</title>
              </circle>
            </g>
          );
        })}
        {/* ARL centre */}
        <circle cx={CX} cy={CY} r={3.5} fill="var(--ink)" />
        <text x={CX} y={CY + 15} textAnchor="middle" className="centre-label">
          ARL
        </text>
      </svg>
      <dl className="facts strike-facts">
        <div>
          <dt>Strikes (10 min)</dt>
          <dd>{derived?.strikesLast10Min ?? 0}</dd>
        </div>
        <div>
          <dt>Nearest</dt>
          <dd>
            {nearestKm == null ? '—' : `${nearestKm.toFixed(1)} km`}
            {derived?.bearingRad != null ? ` ${compassFromRad(derived.bearingRad) ?? ''}` : ''}
            {derived?.withinMaxKm && (
              <>
                {' '}
                <SeverityBadge severity="critical">Inside limit</SeverityBadge>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Approach</dt>
          <dd>
            {derived?.approachKmh == null
              ? '—'
              : derived.approachKmh > 0
                ? `${derived.approachKmh.toFixed(0)} km/h closing`
                : derived.approachKmh < 0
                  ? `${Math.abs(derived.approachKmh).toFixed(0)} km/h receding`
                  : 'Steady'}
          </dd>
        </div>
      </dl>
      {strikes.length === 0 && <p className="muted small">No strikes detected in this window.</p>}
    </div>
  );
}
