// The five weather sites as cards in "station model" form: temperature, dew point, pressure with a 3 h
// tendency arrow, a wind barb + speed, rain over the last hour, a battery bar and a two-hour sparkline of
// the site's key variable (the sonic/soiling/pan stream where the site has one, temperature otherwise).
// Offline and backfilling sites keep their last value visible under the stale hatch and say "Last seen <time>".
// Each card carries its own collapsible control panel scoped to that one site, so a command is never
// broadcast and the entity-restricted ones (clean the reference cell, refill the pan) appear only where they
// apply. All numbers come from the server; the card only formats and colours them.
import { useEffect, useMemo, useState } from 'react';
import { ControlPanel } from '../ControlPanel';
import { StatusPill, type Tone } from '../ui';
import { WindBarbSvg } from './WeatherMap';
import { api } from '../../lib/api';
import { fmtAgo, fmtNum, fmtTime } from '../../lib/format';
import { compassFromRad, fmtC, fmtSigned, type LwmLimits, type LwmSiteDTO, type LwmSiteHistory } from '../../lib/lwm';

function gustTone(g: number | null, limits: LwmLimits): Tone | undefined {
  if (g == null) return undefined;
  return g > limits.highWindCritMs ? 'bad' : g > limits.highWindWarnMs ? 'warn' : 'ok';
}

function tempTone(k: number | null, limits: LwmLimits): Tone | undefined {
  if (k == null) return undefined;
  return k < limits.temperatureMinK || k > limits.temperatureMaxK ? 'warn' : undefined;
}

/** Pressure 3 h tendency: an up arrow, down arrow or flat bar, coloured by magnitude. */
function PressureTrend({ value }: { value: number | null }) {
  if (value == null) return <span className="muted small">—</span>;
  const rising = value > 0.4;
  const falling = value < -0.4;
  const colour = falling ? 'var(--accent)' : rising ? 'var(--sunset)' : 'var(--ink-muted)';
  const arrow = rising ? 'M 6 1 L 6 11 M 6 1 L 3 4 M 6 1 L 9 4' : falling ? 'M 6 1 L 6 11 M 6 11 L 3 8 M 6 11 L 9 8' : 'M 2 6 L 10 6';
  return (
    <span className="site-trend" style={{ color: colour }} title={`3 h tendency ${fmtSigned(value, 'hPa')}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d={arrow} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="arl-num">{fmtSigned(value, 'hPa')}</span>
    </span>
  );
}

/** Compact battery bar: from minV to a nominal full charge, tone follows the current level. */
function BatteryBar({ volts, minV }: { volts: number | null; minV: number }) {
  const high = Math.max(13.0, (volts ?? 0) + 0.5);
  const frac = volts == null ? 0 : Math.min(1, Math.max(0, (volts - minV) / (high - minV || 1)));
  const tone: Tone = volts == null ? 'idle' : volts <= minV ? 'bad' : volts <= minV + 0.4 ? 'warn' : 'ok';
  const barColour = tone === 'bad' ? 'var(--alarm-critical)' : tone === 'warn' ? 'var(--alarm-warning)' : 'var(--accent)';
  return (
    <span className="site-battery" title={volts == null ? 'no reading' : `${volts.toFixed(2)} V, minimum ${minV.toFixed(1)} V`}>
      <span className="site-battery__bar" role="img" aria-label={`battery ${volts == null ? 'unknown' : `${volts.toFixed(2)} V`} of nominal ${high.toFixed(1)} V`}>
        <span className="site-battery__fill" style={{ width: `${(frac * 100).toFixed(1)}%`, background: barColour }} />
      </span>
      <span className="arl-num">{volts == null ? '—' : `${volts.toFixed(2)} V`}</span>
    </span>
  );
}

/** 2-hour sparkline; the first non-null value anchors the left, the last the right. Markers are events. */
function Spark({
  ts,
  values,
  unit,
  markers,
  label,
  height = 34,
  width = 168,
}: {
  ts: number[];
  values: (number | null)[];
  unit: string;
  markers?: { ts: number; title: string }[];
  label: string;
  height?: number;
  width?: number;
}) {
  const { path, min, max, last } = useMemo(() => {
    if (ts.length < 2) return { path: '', min: null as number | null, max: null as number | null, last: null as number | null };
    const vs = values.filter((v): v is number => v != null);
    if (vs.length < 2) return { path: '', min: null as number | null, max: null as number | null, last: null as number | null };
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const span = hi - lo || 1;
    const t0 = ts[0]!;
    const t1 = ts[ts.length - 1]!;
    const px = (t: number) => ((t - t0) / (t1 - t0 || 1)) * width;
    const py = (v: number) => height - 3 - ((v - lo) / span) * (height - 6);
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
    let lastV: number | null = null;
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i];
      if (v != null) {
        lastV = v;
        break;
      }
    }
    return { path: d.trim(), min: lo, max: hi, last: lastV };
  }, [ts, values, width, height]);

  if (!path) return <p className="muted small">No samples yet.</p>;
  const t0 = ts[0]!;
  const t1 = ts[ts.length - 1]!;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}: ${fmtNum(last, 1)} ${unit}, min ${fmtNum(min, 1)}, max ${fmtNum(max, 1)} between ${fmtTime(t0)} and ${fmtTime(t1)}`}
      className="site-spark"
      preserveAspectRatio="none"
    >
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.2} />
      {markers?.map((m) => {
        if (m.ts < t0 || m.ts > t1) return null;
        const x = ((m.ts - t0) / (t1 - t0 || 1)) * width;
        return (
          <g key={m.ts}>
            <line x1={x} y1={0} x2={x} y2={height} stroke="var(--ink-muted)" strokeWidth={1} strokeDasharray="2 2">
              <title>{m.title}</title>
            </line>
          </g>
        );
      })}
    </svg>
  );
}

function useSiteHistory(id: string, hours: number, refreshMs = 180_000): LwmSiteHistory | null {
  const [hist, setHist] = useState<LwmSiteHistory | null>(null);
  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    const load = () =>
      api
        .get<LwmSiteHistory>(`/api/lwm/sites/${encodeURIComponent(id)}/history?hours=${hours}`, { signal: ac.signal })
        .then((h) => alive && setHist(h))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
      ac.abort();
    };
  }, [id, hours, refreshMs]);
  return hist;
}

function StationCard({ s, now, limits }: { s: LwmSiteDTO; now: number | null; limits: LwmLimits }) {
  const w = s.latest;
  const d = s.derived;
  const hist = useSiteHistory(s.id, 2);
  const extra = s.sonic ? 'sonic' : s.soiling ? 'soiling' : s.pan ? 'pan' : null;

  // key variable per site: the site's own instrument stream when it has one, otherwise temperature (°C)
  const spark = useMemo(() => {
    if (!hist) return null;
    const ts = hist.series.ts;
    if (extra === 'sonic' && hist.sonic && hist.sonic.length > 1) {
      return { ts: hist.sonic.map((r) => r.ts), values: hist.sonic.map((r) => r.sonicTemperatureK), unit: 'K', label: 'Sonic temperature' };
    }
    if (extra === 'soiling' && hist.soiling && hist.soiling.length > 1) {
      return { ts: hist.soiling.map((r) => r.ts), values: hist.soiling.map((r) => r.soilingRatio), unit: 'ratio', label: 'Soiling ratio' };
    }
    if (extra === 'pan' && hist.pan && hist.pan.length > 1) {
      return { ts: hist.pan.map((r) => r.ts), values: hist.pan.map((r) => r.panLevelMm), unit: 'mm', label: 'Pan level' };
    }
    return { ts, values: hist.series.temperatureK.map((k) => (k == null ? null : k - 273.15)), unit: '°C', label: 'Temperature' };
  }, [hist, extra]);

  const markers = useMemo(() => {
    const out: { ts: number; title: string }[] = [];
    if (extra === 'soiling' && s.lastCleaning != null) out.push({ ts: s.lastCleaning, title: `Reference cell cleaned ${fmtTime(s.lastCleaning)}` });
    if (extra === 'pan' && s.lastRefill != null) out.push({ ts: s.lastRefill, title: `Pan refilled ${fmtTime(s.lastRefill)}` });
    return out;
  }, [extra, s.lastCleaning, s.lastRefill]);

  const stateTone: Tone = s.backfilling ? 'info' : s.online ? 'ok' : s.enabled === false ? 'idle' : 'bad';
  const stateText = s.backfilling ? 'backfilling' : s.online ? 'online' : s.enabled === false ? 'disabled' : 'offline';
  const stale = !s.online && s.enabled !== false;

  return (
    <div className={`tile site-station${stale || s.backfilling ? ' tile-stale' : ''}`}>
      <div className="tile-head">
        <div>
          <div className="tile-code">{s.id}</div>
          <div className="tile-name">
            {w ? `updated ${fmtAgo(w.ts, now)}` : 'no sample yet'}
            {s.sampleIntervalS != null ? ` · every ${s.sampleIntervalS} s` : ''}
          </div>
          {stale && w && <div className="arl-label reading-stale">Last seen {fmtTime(w.ts)}</div>}
        </div>
        <StatusPill tone={stateTone} title={stateText}>
          {stateText}
        </StatusPill>
      </div>

      <div className="station-model">
        <span className="station-cell" title="Temperature">
          <span className="kv-k">Temp</span>
          <span className={tempTone(w?.temperatureK ?? null, limits) ? `tone-${tempTone(w?.temperatureK ?? null, limits)}` : undefined}>{fmtC(w?.temperatureK)}</span>
        </span>
        <span className="station-cell" title="Dew point">
          <span className="kv-k">Dew</span>
          <span>{fmtC(d.dewPointK)}</span>
        </span>
        <span className="station-cell" title="Pressure and 3 h tendency">
          <span className="kv-k">Pressure</span>
          <span>{w?.pressureHpa == null ? '—' : `${fmtNum(w.pressureHpa, 1)} hPa`}</span>
          <PressureTrend value={d.pressureTendencyHpa3h} />
        </span>
        <span className="station-cell station-cell--wind" title="Wind (barb + speed + direction)">
          <span className="kv-k">Wind</span>
          <span className="station-wind">
            <WindBarbSvg speedMs={w?.windSpeedMs ?? null} dirRad={w?.windDirectionRad ?? null} title={w?.windSpeedMs == null ? 'no wind' : `${w.windSpeedMs.toFixed(1)} m/s from ${compassFromRad(w.windDirectionRad) ?? '—'}`} />
            <span>
              {w?.windSpeedMs == null ? '—' : `${fmtNum(w.windSpeedMs, 1)} m/s ${compassFromRad(w.windDirectionRad) ?? ''}`}
              {w?.windGustMs != null && <span className={gustTone(w.windGustMs, limits) ? `tone-${gustTone(w.windGustMs, limits)}` : undefined}> · gust {fmtNum(w.windGustMs, 1)}</span>}
            </span>
          </span>
        </span>
        <span className="station-cell" title="Rain in the last hour">
          <span className="kv-k">Rain 1 h</span>
          <span>{d.rainRateMmH == null ? '—' : `${fmtNum(d.rainRateMmH, 1)} mm`}</span>
        </span>
        <span className="station-cell" title="Battery">
          <span className="kv-k">Battery</span>
          <BatteryBar volts={d.battery.batteryV} minV={d.battery.minV} />
        </span>
      </div>

      {spark && (
        <div className="station-spark">
          <span className="muted small">{spark.label} · 2 h</span>
          <Spark ts={spark.ts} values={spark.values} unit={spark.unit} markers={markers.length ? markers : undefined} label={spark.label} />
        </div>
      )}

      <ControlPanel service="lwm" entities={[s.id]} kinds={['site']} collapsible title="Site controls" />
    </div>
  );
}

export function SiteCards({ sites, now, limits }: { sites: LwmSiteDTO[]; now: number | null; limits: LwmLimits }) {
  if (sites.length === 0) return <p className="muted small">No sites yet.</p>;
  return (
    <div className="tiles site-tiles">
      {sites.map((s) => (
        <StationCard key={s.id} s={s} now={now} limits={limits} />
      ))}
    </div>
  );
}
