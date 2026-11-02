// Wind rose, classic form: 16 direction bins stacked radially by wind-speed class, each ring a frequency
// slice. Radius of a sub-wedge is the fraction of the samples that fell in that (direction, class) pair,
// so the outer edge of the petal is the total frequency of that direction and the colour bands read as
// "how often the wind came from here at that strength". A toggle picks one site or all sites combined.
// Samples are pulled from the same site-history endpoint the page already uses for its per-site charts,
// so the rose works in replay too (the server returns the window ending at the sim clock it is on).
import { useEffect, useMemo, useState } from 'react';
import { rampAt, rgbCss, sequentialStops, useThemeColors } from '../../lib/colors';
import { api } from '../../lib/api';
import type { LwmSiteHistory } from '../../lib/lwm';

const SIZE = 260;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R_MAX = SIZE / 2 - 30;

/** Six classes, from calm to gale; the label is what the tooltip and legend show. */
const SPEED_CLASSES: { max: number; label: string }[] = [
  { max: 0.5, label: 'Calm <0.5 m/s' },
  { max: 5, label: '0.5–5 m/s' },
  { max: 10, label: '5–10 m/s' },
  { max: 15, label: '10–15 m/s' },
  { max: 20, label: '15–20 m/s' },
  { max: Infinity, label: '>20 m/s' },
];

const DIR_BINS = 16;
const BIN_DEG = 360 / DIR_BINS;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function classIndex(speedMs: number): number {
  for (let i = 0; i < SPEED_CLASSES.length; i++) if (speedMs < SPEED_CLASSES[i]!.max) return i;
  return SPEED_CLASSES.length - 1;
}

function binRose(samples: { speedMs: number; dirRad: number }[]): { counts: number[][]; total: number } {
  const counts: number[][] = [];
  for (let i = 0; i < DIR_BINS; i++) counts.push(new Array<number>(SPEED_CLASSES.length).fill(0));
  let total = 0;
  for (const s of samples) {
    const deg = (((s.dirRad * 180) / Math.PI) % 360 + 360) % 360;
    const idx = Math.round(deg / BIN_DEG) % DIR_BINS;
    counts[idx]![classIndex(s.speedMs)]! += 1;
    total += 1;
  }
  return { counts, total };
}

/** North-up polar → SVG cartesian. */
function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

function wedgePath(a0: number, a1: number, r0: number, r1: number): string {
  const [x0, y0] = polar(a0, r0);
  const [x1, y1] = polar(a1, r0);
  const [x2, y2] = polar(a1, r1);
  const [x3, y3] = polar(a0, r1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return [
    `M ${x0.toFixed(2)} ${y0.toFixed(2)}`,
    `A ${r0.toFixed(2)} ${r0.toFixed(2)} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `L ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `A ${r1.toFixed(2)} ${r1.toFixed(2)} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    'Z',
  ].join(' ');
}

interface RoseSampleSource {
  ids: string[];
  hours: number;
}

export function WindRose({
  source,
  scope,
  onScopeChange,
  siteIds,
  label = 'Wind rose',
}: {
  source: RoseSampleSource;
  /** Selected site id, or "all" for every site in the network. */
  scope: string;
  onScopeChange: (v: string) => void;
  siteIds: string[];
  label?: string;
}) {
  const colours = useThemeColors();
  const stops = sequentialStops(colours);
  const [rows, setRows] = useState<{ speedMs: number; dirRad: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    const ids = scope === 'all' ? source.ids : [scope];
    void Promise.all(
      ids.map((id) =>
        api
          .get<LwmSiteHistory>(`/api/lwm/sites/${encodeURIComponent(id)}/history?hours=${source.hours}`, { signal: ac.signal })
          .catch(() => null),
      ),
    ).then((list) => {
      if (!alive) return;
      const samples: { speedMs: number; dirRad: number }[] = [];
      for (const h of list) {
        if (!h) continue;
        const s = h.series;
        for (let i = 0; i < s.ts.length; i++) {
          const sp = s.windSpeedMs[i];
          const dir = s.windDirectionRad[i];
          if (sp == null || dir == null || !Number.isFinite(sp) || !Number.isFinite(dir)) continue;
          samples.push({ speedMs: sp, dirRad: dir });
        }
      }
      setRows(samples);
      setError(null);
    });
    return () => {
      alive = false;
      ac.abort();
    };
  }, [scope, source.ids, source.hours]);

  const { counts, total, maxFreq, dominant } = useMemo(() => {
    const b = binRose(rows);
    let maxSum = 0;
    let dominantIdx = -1;
    for (let i = 0; i < DIR_BINS; i++) {
      const s = b.counts[i]!.reduce((a, c) => a + c, 0);
      if (s > maxSum) {
        maxSum = s;
        dominantIdx = i;
      }
    }
    // radius = fraction of all samples in that direction (per-class stack sums to the direction total)
    const maxFraction = b.total > 0 ? maxSum / b.total : 0;
    return { counts: b.counts, total: b.total, maxFreq: maxFraction, dominant: dominantIdx };
  }, [rows]);

  const ringFracs = maxFreq > 0 ? [0.25, 0.5, 0.75, 1].map((f) => f * maxFreq) : [0.25, 0.5, 0.75, 1].map((f) => f * 0.25);

  // colour per class: sequential ramp at class / lastClass (calm = dust, gale = peak)
  const classColour = (i: number): string => rgbCss(rampAt(stops, i / (SPEED_CLASSES.length - 1)));

  return (
    <div className="wind-rose">
      <div className="row gap" style={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <label className="field-inline">
          <span className="muted small">Scope</span>
          <select value={scope} onChange={(e) => onScopeChange(e.target.value)} aria-label="Wind rose scope">
            <option value="all">All sites</option>
            {siteIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">{total} samples · {source.hours} h</span>
      </div>
      {error && <p className="muted small">{error}</p>}
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={label} className="rose-svg">
        {/* frequency rings at quarter steps of the current max */}
        {ringFracs.map((f, i) => (
          <circle key={`r${i}`} cx={CX} cy={CY} r={maxFreq > 0 ? R_MAX * (f / maxFreq) : R_MAX * (i + 1) * 0.25} fill="none" stroke="var(--line)" strokeWidth={1} />
        ))}
        {/* spokes + compass */}
        {Array.from({ length: DIR_BINS }).map((_, i) => {
          const [x, y] = polar(i * BIN_DEG, R_MAX);
          return <line key={`s-${i}`} x1={CX} y1={CY} x2={x} y2={y} stroke="var(--line)" strokeWidth={0.5} />;
        })}
        {(['N', 'E', 'S', 'W'] as const).map((c, i) => {
          const [x, y] = polar(i * 90, R_MAX + 15);
          return (
            <text key={c} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="rose-label">
              {c}
            </text>
          );
        })}
        {/* stacked petals */}
        {total > 0 &&
          counts.map((cls, i) => {
            let r0 = 0;
            const a0 = i * BIN_DEG - BIN_DEG / 2;
            const a1 = i * BIN_DEG + BIN_DEG / 2;
            return (
              <g key={`bin-${i}`}>
                {cls.map((count, k) => {
                  if (count === 0) return null;
                  const frac = count / total;
                  const r1 = (frac / maxFreq) * R_MAX;
                  const path = wedgePath(a0, a1, r0, r1);
                  r0 = r1;
                  return (
                    <path key={`c-${k}`} d={path} fill={classColour(k)} fillOpacity={0.9} stroke="var(--line-strong)" strokeWidth={0.4}>
                      <title>{`${COMPASS[i]} ${SPEED_CLASSES[k]!.label}: ${count} (${Math.round(frac * 100)} %)`}</title>
                    </path>
                  );
                })}
              </g>
            );
          })}
        <circle cx={CX} cy={CY} r={2} fill="var(--ink-muted)" />
        {total === 0 && (
          <text x={CX} y={CY} textAnchor="middle" dominantBaseline="middle" className="rose-empty">
            No wind yet
          </text>
        )}
      </svg>
      <ul className="rose-legend" aria-label="Speed class colours">
        {SPEED_CLASSES.map((sc, i) => (
          <li key={sc.label}>
            <span className="rose-swatch" style={{ background: classColour(i) }} aria-hidden="true" />
            <span className="muted small">{sc.label}</span>
          </li>
        ))}
      </ul>
      <p className="muted small rose-note">
        {dominant >= 0 && total > 0
          ? `Dominant from ${COMPASS[dominant]} (${Math.round(dominant * BIN_DEG)}°); outer ring ${(maxFreq * 100).toFixed(0)} % of samples.`
          : 'Waiting for wind samples.'}
      </p>
    </div>
  );
}
