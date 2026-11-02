// Storm tracker: one card that answers "how close is it, which way is it going and when does it matter".
// Nearest strike (distance + compass), the approach speed with a closing/receding arrow, the estimated time
// for the nearest strike to cross the lightning alert radius, a 5-minute-bin strike-count sparkline and a
// plain-words status line. Everything is computed from the strike list and the derived numbers the server
// already streams — the card only formats.
import { useMemo } from 'react';
import { SeverityBadge, StatusPill } from '../ui';
import { fmtTime } from '../../lib/format';
import { compassFromRad, type LightningDerived, type LwmLimits, type LwmStrike } from '../../lib/lwm';

const BIN_MS = 5 * 60_000;
const WINDOW_MS = 30 * 60_000;

export interface StormBin {
  fromTs: number;
  count: number;
}

/** Strike counts in 5-minute bins across the last 30 minutes, oldest first (empty bins included). */
export function strikeBins(strikes: LwmStrike[], now: number | null, binMs = BIN_MS, windowMs = WINDOW_MS): StormBin[] {
  if (now == null) return [];
  const start = Math.floor((now - windowMs) / binMs) * binMs;
  const n = Math.max(1, Math.floor(windowMs / binMs));
  const out: StormBin[] = [];
  for (let i = 0; i < n; i++) out.push({ fromTs: start + i * binMs, count: 0 });
  for (const s of strikes) {
    if (s.ts < start || s.ts > now) continue;
    const idx = Math.min(n - 1, Math.floor((s.ts - start) / binMs));
    out[idx]!.count += 1;
  }
  return out;
}

export function StormSparkline({ bins, label }: { bins: StormBin[]; label: string }) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  return (
    <svg viewBox={`0 0 ${Math.max(1, bins.length) * 10} 34`} role="img" aria-label={label} preserveAspectRatio="none" style={{ width: '100%', height: 34, display: 'block' }}>
      {bins.map((b, i) => {
        const h = (b.count / max) * 26;
        return (
          <rect key={b.fromTs} x={i * 10 + 1} y={30 - h} width={7} height={Math.max(b.count > 0 ? 1.5 : 0, h)} fill="var(--ochre)" opacity={b.count > 0 ? 0.9 : 0.25}>
            <title>{`${fmtTime(b.fromTs)} – ${fmtTime(b.fromTs + BIN_MS)}: ${b.count} strike${b.count === 1 ? '' : 's'}`}</title>
          </rect>
        );
      })}
      <line x1={0} y1={30.5} x2={Math.max(1, bins.length) * 10} y2={30.5} stroke="var(--line)" strokeWidth={1} />
    </svg>
  );
}

function ApproachArrow({ approachKmh }: { approachKmh: number | null }) {
  const dir = approachKmh == null ? 'steady' : approachKmh > 1 ? 'closing' : approachKmh < -1 ? 'receding' : 'steady';
  const rotation = dir === 'closing' ? 0 : dir === 'receding' ? 180 : 0;
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ transform: `rotate(${rotation}deg)`, opacity: dir === 'steady' ? 0.5 : 1 }}>
      <path d="M8 2.5v11M8 2.5 4.4 6.2M8 2.5l3.6 3.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StormTracker({
  strikes,
  derived,
  limits,
  now,
  latestStrikeTs,
}: {
  /** Strikes in the window (oldest first); the card bins the last 30 minutes itself. */
  strikes: LwmStrike[];
  derived: LightningDerived | null;
  limits: LwmLimits | null;
  now: number | null;
  /** Timestamp of the newest strike, used as the age reference for the nearest-strike line. */
  latestStrikeTs?: number | null;
}) {
  const bins = useMemo(() => strikeBins(strikes, now), [strikes, now]);
  const maxKm = limits?.lightningMaxKm ?? 10;
  const nearestKm = derived?.nearestKm ?? null;
  const approach = derived?.approachKmh ?? null;
  const bearing = derived?.bearingRad ?? null;
  const compass = compassFromRad(bearing);

  const etaMin = nearestKm != null && approach != null && approach > 0.5 ? ((nearestKm - maxKm) / approach) * 60 : null;
  const total = bins.reduce((a, b) => a + b.count, 0);
  const tone = derived?.withinMaxKm ? 'bad' : nearestKm != null && nearestKm <= maxKm * 2.5 ? 'warn' : 'ok';

  const statusLine = (() => {
    if (nearestKm == null) return total > 0 ? `${total} strike${total === 1 ? '' : 's'} detected, distance not reported.` : 'No strikes detected in the last 30 minutes.';
    const where = `${nearestKm.toFixed(0)} km${compass ? ` ${compass}` : ''}`;
    const motion = approach == null ? 'motion unclear' : approach > 1 ? `closing at ${approach.toFixed(0)} km/h` : approach < -1 ? `receding at ${Math.abs(approach).toFixed(0)} km/h` : 'holding distance';
    if (derived?.withinMaxKm) return `Storm ${where}, ${motion} — inside the ${maxKm} km alert radius; technician visits are blocked.`;
    if (etaMin != null && etaMin <= 180) return `Storm ${where}, ${motion}, about ${Math.max(1, Math.round(etaMin))} min to the ${maxKm} km alert radius.`;
    if (etaMin != null) return `Storm ${where}, ${motion}; roughly ${(etaMin / 60).toFixed(1)} h to the ${maxKm} km alert radius.`;
    return `Storm ${where}, ${motion}.`;
  })();

  return (
    <div className="storm-tracker">
      <div className="row gap" style={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <StatusPill tone={tone}>{derived?.withinMaxKm ? 'Inside limit' : total > 0 ? 'Storm watch' : 'Quiet'}</StatusPill>
        <span className="muted small">{total} strike{total === 1 ? '' : 's'} in 30 min</span>
      </div>

      <dl className="facts">
        <div>
          <dt>Nearest strike</dt>
          <dd>
            {nearestKm == null ? '—' : `${nearestKm.toFixed(1)} km`}
            {compass ? ` ${compass}` : ''}
            <span className="muted small"> · {derived?.strikesLast10Min ?? 0} in last 10 min{latestStrikeTs != null ? ` · latest ${fmtTime(latestStrikeTs)}` : ''}</span>
          </dd>
        </div>
        <div>
          <dt>Approach</dt>
          <dd className="row gap" style={{ alignItems: 'center', gap: 'var(--space-1)', color: approach == null ? 'var(--ink-muted)' : approach > 1 ? 'var(--accent)' : 'var(--ink)' }}>
            <ApproachArrow approachKmh={approach} />
            {approach == null ? '—' : `${Math.abs(approach).toFixed(0)} km/h ${approach > 1 ? 'closing' : approach < -1 ? 'receding' : 'steady'}`}
          </dd>
        </div>
        <div>
          <dt>Time to {maxKm} km radius</dt>
          <dd>{etaMin == null ? '—' : etaMin <= 0 ? 'Now inside' : etaMin < 90 ? `${Math.round(etaMin)} min` : `${(etaMin / 60).toFixed(1)} h`}</dd>
        </div>
      </dl>

      <StormSparkline bins={bins} label={`Strikes per five minutes over the last 30 minutes: ${bins.map((b) => b.count).join(', ')}`} />

      <p className="storm-status">
        {derived?.withinMaxKm && <SeverityBadge severity="critical" compact />}
        {statusLine}
      </p>
    </div>
  );
}
