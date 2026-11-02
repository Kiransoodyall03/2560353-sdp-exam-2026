// Site history as small multiples: five rows on one shared time axis. Temperature with its comfort band
// (the shaded slice between temperature and dew point), pressure with a rolling 3 h tendency, wind speed
// with the gust envelope as a band, rain as bars and the site's own stream (sonic delta for lwm-3, soiling
// with cleaning markers for lwm-4, pan level with refill markers for lwm-5). Everything is drawn as one
// SVG per row so the shared axis stays pixel-aligned at every width and the reduced-motion rule applies
// (no animated transitions).
import { useMemo, type ReactElement } from 'react';
import { cssVar, useThemeColors } from '../../lib/colors';
import { fmtNum, fmtTime } from '../../lib/format';
import { fmtC, type LwmSiteDTO, type LwmSiteHistory } from '../../lib/lwm';

const ROW_H = 84;
const PAD_L = 54;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 6;

interface Range {
  lo: number;
  hi: number;
}

function extent(values: (number | null)[]): Range | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return null;
  if (hi === lo) return { lo: lo - 1, hi: hi + 1 };
  return { lo, hi };
}

/** Rolling pressure tendency over 3 h: nearest sample to (t − 3h) subtracted from the value at t. */
function rollingTendency(ts: number[], values: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = [];
  let j = 0;
  for (let i = 0; i < ts.length; i++) {
    const target = ts[i]! - 3 * 3_600_000;
    while (j + 1 < ts.length && Math.abs(ts[j + 1]! - target) <= Math.abs(ts[j]! - target)) j++;
    const v = values[i];
    const base = values[j];
    out.push(v != null && base != null ? v - base : null);
  }
  return out;
}

export function SiteMultiples({ hist, site, hours }: { hist: LwmSiteHistory; site: LwmSiteDTO | null; hours: number }) {
  const c = useThemeColors();
  const tsAll = hist.series.ts;
  const { t0, t1 } = useMemo(() => {
    if (tsAll.length === 0) return { t0: hist.from, t1: hist.to };
    return { t0: tsAll[0]!, t1: tsAll[tsAll.length - 1]! };
  }, [tsAll, hist.from, hist.to]);

  const width = 900; // viewBox width; scales to the container
  const plotW = width - PAD_L - PAD_R;
  const px = (t: number) => PAD_L + ((t - t0) / (t1 - t0 || 1)) * plotW;

  const tempC = hist.series.temperatureK.map((k) => (k == null ? null : k - 273.15));
  const dewC = useMemo(() => {
    // dew point is only published on the network snapshot; approximate per sample from temp + humidity
    const t = hist.series.temperatureK;
    const h = hist.series.humidityPct;
    const b = 17.625;
    const cc = 243.04;
    const out: (number | null)[] = [];
    for (let i = 0; i < t.length; i++) {
      const tk = t[i];
      const rh = h[i];
      if (tk == null || rh == null || !(rh > 0) || rh > 100) {
        out.push(null);
        continue;
      }
      const tt = tk - 273.15;
      const g = Math.log(rh / 100) + (b * tt) / (cc + tt);
      const den = b - g;
      out.push(den === 0 ? null : (cc * g) / den);
    }
    return out;
  }, [hist]);

  const pressure = hist.series.pressureHpa;
  const tendency = useMemo(() => rollingTendency(tsAll, pressure), [tsAll, pressure]);

  const wind = hist.series.windSpeedMs;
  const gust = hist.series.windGustMs;
  const rain = hist.series.rainfallMm;

  // site-specific stream: sonic delta, soiling ratio (with a cleaning marker) or pan level (with a refill marker)
  const stream = useMemo(() => {
    if (hist.sonic && hist.sonic.length > 1) {
      const ts = hist.sonic.map((r) => r.ts);
      const t = hist.series.temperatureK;
      const values = hist.sonic.map((r) => {
        if (r.sonicTemperatureK == null) return null;
        let best: number | null = null;
        let bestD = Infinity;
        for (let i = 0; i < hist.series.ts.length; i++) {
          const d = Math.abs(hist.series.ts[i]! - r.ts);
          if (d < bestD) {
            bestD = d;
            best = t[i] ?? null;
          }
        }
        return best == null ? null : r.sonicTemperatureK - best;
      });
      return { label: 'Sonic Δ vs main', unit: 'K', ts, values, markers: [] as { ts: number; title: string }[] };
    }
    if (hist.soiling && hist.soiling.length > 1) {
      return {
        label: 'Soiling ratio',
        unit: 'ratio',
        ts: hist.soiling.map((r) => r.ts),
        values: hist.soiling.map((r) => r.soilingRatio),
        markers: site?.lastCleaning != null ? [{ ts: site.lastCleaning, title: `Reference cell cleaned ${fmtTime(site.lastCleaning)}` }] : [],
      };
    }
    if (hist.pan && hist.pan.length > 1) {
      return {
        label: 'Pan level',
        unit: 'mm',
        ts: hist.pan.map((r) => r.ts),
        values: hist.pan.map((r) => r.panLevelMm),
        markers: site?.lastRefill != null ? [{ ts: site.lastRefill, title: `Pan refilled ${fmtTime(site.lastRefill)}` }] : [],
      };
    }
    return null;
  }, [hist, site]);

  const rowsData = useMemo(() => {
    const r: { key: string; label: string; unit: string; range: Range | null }[] = [];
    r.push({ key: 'temp', label: 'Temperature', unit: '°C', range: extent([...tempC, ...dewC]) });
    r.push({ key: 'pressure', label: 'Pressure', unit: 'hPa', range: extent(pressure) });
    r.push({ key: 'wind', label: 'Wind + gust', unit: 'm/s', range: extent([...wind, ...gust]) });
    r.push({ key: 'rain', label: 'Rain', unit: 'mm', range: { lo: 0, hi: Math.max(0.2, ...rain.map((v) => v ?? 0)) } });
    if (stream) r.push({ key: 'stream', label: stream.label, unit: stream.unit, range: extent(stream.values) });
    return r;
  }, [tempC, dewC, pressure, wind, gust, rain, stream]);

  const trendRange = extent(tendency);
  const rowsCount = rowsData.length;
  const totalH = ROW_H * rowsCount + 22;

  const fmt = (v: number | null, digits = 1): string => (v == null ? '—' : fmtNum(v, digits));

  const line = (ts: number[], values: (number | null)[], colour: string, py: (v: number) => number, widthPx = 1.4, dash?: number[]): ReactElement => {
    let d = '';
    let started = false;
    for (let i = 0; i < ts.length; i++) {
      const v = values[i];
      if (v == null) {
        started = false;
        continue;
      }
      d += `${started ? 'L' : 'M'} ${px(ts[i]!).toFixed(1)} ${py(v).toFixed(1)} `;
      started = true;
    }
    return <path d={d.trim()} fill="none" stroke={colour} strokeWidth={widthPx} {...(dash ? { strokeDasharray: dash.join(' ') } : {})} />;
  };

  const band = (
    ts: number[],
    lower: (number | null)[],
    upper: (number | null)[],
    colour: string,
    pyLo: (v: number) => number,
    pyHi: (v: number) => number = pyLo,
  ): ReactElement | null => {
    const pts: [number, number, number, number][] = [];
    for (let i = 0; i < ts.length; i++) {
      const a = lower[i];
      const b = upper[i];
      if (a == null || b == null) continue;
      pts.push([px(ts[i]!), pyLo(Math.min(a, b)), px(ts[i]!), pyHi(Math.max(a, b))]);
    }
    if (pts.length < 2) return null;
    const top = pts.map((p) => `${p[0].toFixed(1)} ${p[3].toFixed(1)}`).join(' L ');
    const bottom = [...pts].reverse().map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ');
    return <path d={`M ${top} L ${bottom} Z`} fill={colour} fillOpacity={0.22} stroke="none" />;
  };

  const ticks = (n = 4): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(t0 + ((t1 - t0) * i) / n);
    return out;
  };

  return (
    <div className="small-multiples">
      <svg viewBox={`0 0 ${width} ${totalH}`} role="img" aria-label={`Site history over ${hours} h`} preserveAspectRatio="none" className="small-multiples__svg">
        {rowsData.map((rd, idx) => {
          const y0 = idx * ROW_H;
          const py = (v: number): number => {
            if (!rd.range) return y0 + ROW_H / 2;
            const span = rd.range.hi - rd.range.lo || 1;
            return y0 + PAD_T + (rd.range.hi - v) * ((ROW_H - PAD_T - PAD_B) / span);
          };
          return (
            <g key={rd.key}>
              <rect x={0} y={y0} width={width} height={ROW_H} fill="none" stroke={c.line} strokeWidth={0.5} />
              <text x={6} y={y0 + 14} className="sm-title" fill={c.ink}>
                {rd.label}
              </text>
              <text x={6} y={y0 + 26} className="sm-unit" fill={c.inkMuted}>
                {rd.unit}
              </text>
              {rd.range && (
                <>
                  <text x={PAD_L - 6} y={y0 + PAD_T + 4} className="sm-ymax" fill={c.inkMuted} textAnchor="end">
                    {fmt(rd.range.hi, rd.key === 'rain' ? 1 : 0)}
                  </text>
                  <text x={PAD_L - 6} y={y0 + ROW_H - PAD_B} className="sm-ymin" fill={c.inkMuted} textAnchor="end">
                    {fmt(rd.range.lo, rd.key === 'rain' ? 1 : 0)}
                  </text>
                </>
              )}
              {rd.key === 'temp' && rd.range && (
                <>
                  {band(tsAll, tempC, dewC, cssVar('--sunset') || 'currentColor', py)}
                  {line(tsAll, tempC, cssVar('--ochre') || 'currentColor', py)}
                  {line(tsAll, dewC, cssVar('--sunset') || 'currentColor', py, 1, [4, 3])}
                </>
              )}
              {rd.key === 'pressure' && rd.range && (
                <>
                  {line(tsAll, pressure, cssVar('--accent') || 'currentColor', py)}
                  {trendRange &&
                    line(
                      tsAll,
                      tendency,
                      cssVar('--ink-muted') || 'currentColor',
                      (v) => {
                        // plot the tendency in the same row band, scaled to its own range
                        const tSpan = trendRange.hi - trendRange.lo || 1;
                        const norm = (v - trendRange.lo) / tSpan;
                        return y0 + PAD_T + (1 - norm) * (ROW_H - PAD_T - PAD_B);
                      },
                      1,
                      [3, 2],
                    )}
                </>
              )}
              {rd.key === 'wind' && rd.range && (
                <>
                  {band(tsAll, wind, gust, cssVar('--dust') || 'currentColor', py)}
                  {line(tsAll, wind, cssVar('--sunset') || 'currentColor', py)}
                  {line(tsAll, gust, cssVar('--accent') || 'currentColor', py, 1.1, [4, 3])}
                </>
              )}
              {rd.key === 'rain' && rd.range && (
                <g>
                  {tsAll.map((t, i) => {
                    const v = rain[i];
                    if (v == null || v <= 0) return null;
                    const x = px(t);
                    const yTop = py(v);
                    const yBase = py(0);
                    return <rect key={t} x={x - 2} y={yTop} width={4} height={Math.max(0.6, yBase - yTop)} fill={cssVar('--sunset') || 'currentColor'} fillOpacity={0.85} />;
                  })}
                </g>
              )}
              {rd.key === 'stream' && stream && rd.range && (
                <>
                  {line(stream.ts, stream.values, cssVar('--accent') || 'currentColor', py)}
                  {stream.markers.map((m) => {
                    if (m.ts < t0 || m.ts > t1) return null;
                    const x = px(m.ts);
                    return (
                      <line key={m.ts} x1={x} y1={y0 + PAD_T} x2={x} y2={y0 + ROW_H - PAD_B} stroke={cssVar('--ink') || 'currentColor'} strokeWidth={1.2} strokeDasharray="3 3">
                        <title>{m.title}</title>
                      </line>
                    );
                  })}
                </>
              )}
            </g>
          );
        })}
        {/* shared time axis */}
        <line x1={PAD_L} y1={totalH - 16} x2={width - PAD_R} y2={totalH - 16} stroke={c.line} strokeWidth={1} />
        {ticks(4).map((t) => (
          <g key={t}>
            <line x1={px(t)} y1={totalH - 16} x2={px(t)} y2={totalH - 12} stroke={c.line} strokeWidth={1} />
            <text x={px(t)} y={totalH - 3} className="sm-tick" fill={c.inkMuted} textAnchor="middle">
              {fmtTime(t)}
            </text>
          </g>
        ))}
      </svg>
      <p className="muted small" style={{ marginTop: 4 }}>
        Temperature with its dew-point comfort band, pressure with a rolling 3 h tendency (dashed), wind speed under its gust envelope,
        rain per sample {stream ? `and the site's own ${stream.label.toLowerCase()} stream` : ''}. Cleaning and refills appear as dashed
        vertical marks.
      </p>
    </div>
  );
}

/** Compact summary the site cards render alongside the small multiples when the panel is empty. */
export function fmtSiteRange(hist: LwmSiteHistory): string {
  return `${fmtC(hist.series.temperatureK.find((v): v is number => v != null) ?? null)} → ${fmtC([...hist.series.temperatureK].reverse().find((v): v is number => v != null) ?? null)}`;
}
