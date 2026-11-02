// RTA main view: KPIs, dish grid, sub-array cards, trends, recent scans.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { DishDTO, SubarrayDTO } from '../../../shared/types';
import { alignSeries, Chart, holdForward } from '../components/Chart';
import { CommandHistory } from '../components/CommandHistory';
import { ControlPanel } from '../components/ControlPanel';
import { DishGrid, DishLegend } from '../components/DishGrid';
import { Empty, ErrorBox, KpiTile, Loading, Panel, SeverityBadge, StatusPill, type Tone } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useThemeColors } from '../lib/colors';
import { fmtDuration, fmtNum, fmtTs } from '../lib/format';
import { BAND_TEXT, subarrayColours, useRtaLive } from '../lib/rta';
import { ScanTable } from './Scans';

export function RtaPage() {
  const rta = useRtaLive();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const highlight = params.get('subarray');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const colours = useMemo(
    () => subarrayColours([...rta.subarrays.map((s) => s.id), ...rta.dishes.flatMap((d) => (d.subarray ? [d.subarray] : []))]),
    [rta.subarrays, rta.dishes],
  );

  if (!rta.global && rta.dishes.length === 0) return <Loading what="radio telescope array" />;
  const g = rta.global;
  const running = rta.subarrays.filter((s) => s.scanState === 'running').length;
  const active = g?.activeDishes ?? null;
  const axis = Math.max(active ?? 0, g?.minActive ?? 0, 1);
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="page">
      <h1>Radio telescope</h1>
      {rta.status !== 'open' && (
        <div className="flag warn">
          <SeverityBadge severity="warning" compact /> Live stream {rta.status}
        </div>
      )}
      <div className="readings">
        <KpiTile
          kpi={{
            label: 'Dishes in service',
            value: active,
            unit: 'dishes',
            status: active == null ? undefined : active < (g?.minActive ?? 0) ? 'bad' : 'ok',
          }}
          fill={active == null ? undefined : active / axis}
          limit={g ? { at: g.minActive / axis, label: `Minimum ${g.minActive} dishes` } : undefined}
          cause={`Minimum for observing is ${g?.minActive ?? '—'} dishes.`}
        />
        <KpiTile
          kpi={{
            label: 'Max gust',
            value: g?.maxGustMs == null ? null : fmtNum(g.maxGustMs, 1),
            unit: 'm/s',
            status: g?.windStow ? 'warn' : 'ok',
          }}
          cause={g?.windStow ? 'Wind stow is engaged, so new scans are blocked.' : 'Highest gust reported by the weather network.'}
        />
        <KpiTile
          kpi={{
            label: 'Stowed dishes',
            value: g?.stowedCount ?? null,
            status: g?.stowedCount ? 'warn' : 'ok',
          }}
          cause={`${running} of ${rta.subarrays.length} sub-arrays are scanning.`}
        />
        <KpiTile
          kpi={{ label: 'Min scan SNR', value: g?.minSnrDb ?? null, unit: 'dB' }}
          cause="Lowest signal-to-noise ratio across the sub-arrays."
        />
      </div>

      <div className="rta-layout">
        <Panel
          title="Dish array"
          actions={
            <>
              {highlight && (
                <button type="button" className="arl-btn" onClick={() => setParams({}, { replace: true })}>
                  Show all (highlighting {highlight})
                </button>
              )}
              <span className="muted small">Click a dish for details, shift-click to select.</span>
            </>
          }
        >
          {rta.dishes.length === 0 ? (
            <Empty>No dish telemetry yet: the array reports its dishes once the service is streaming.</Empty>
          ) : (
            <DishGrid
              dishes={rta.dishes}
              colours={colours}
              selected={selected}
              highlight={highlight}
              windStow={!!g?.windStow}
              onOpen={(id) => nav(`/rta/dish/${id}`)}
              onToggle={toggle}
            />
          )}
          <DishLegend />
          {g?.windStow && (
            <p className="small">
              <SeverityBadge severity="warning">Wind stow engaged</SeverityBadge>{' '}
              {g.windStowSinceTs ? `since ${fmtTs(g.windStowSinceTs)}. ` : ''}New scans are blocked until it clears.
            </p>
          )}
          {selected.size > 0 && <Selection ids={[...selected]} byId={rta.dishById} onClear={() => setSelected(new Set())} />}
        </Panel>
        <div className="stack">
          {rta.subarrays.length === 0 && <Panel title="Sub-arrays">No sub-arrays reported.</Panel>}
          {rta.subarrays.map((s) => (
            <SubarrayCard
              key={s.id}
              s={s}
              colour={colours.get(s.id) ?? 'var(--ink-muted)'}
              simNow={rta.simTs}
              onHighlight={() => setParams({ subarray: s.id }, { replace: true })}
            />
          ))}
        </div>
      </div>

      <Trends />

      <Panel
        title="Command history"
        actions={<span className="muted small">every command is verified server-side before it is published</span>}
      >
        <CommandHistory service="rta" limit={15} />
      </Panel>

      <Panel
        title="Recent scans"
        actions={
          <Link to="/rta/scans" className="arl-btn">
            Scan library
          </Link>
        }
      >
        <ScanTable scans={rta.scans.slice(0, 8)} />
      </Panel>
    </div>
  );
}

function Selection({ ids, byId, onClear }: { ids: string[]; byId: Map<string, DishDTO>; onClear: () => void }) {
  const dishes = ids.map((id) => byId.get(id)).filter((d): d is DishDTO => !!d);
  const counts = new Map<string, number>();
  for (const d of dishes) counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
  const sorted = [...ids].sort();
  return (
    <div className="selection">
      <strong>{dishes.length} selected</strong>{' '}
      <span className="muted small">{[...counts].map(([s, n]) => `${n} ${s}`).join(' · ')}</span>
      <div className="mono small">{sorted.join(', ')}</div>
      <div className="row gap">
        <button type="button" className="arl-btn" onClick={onClear}>
          Clear selection
        </button>
      </div>
      <ControlPanel service="rta" entities={sorted} kinds={['dish']} title="Batch dish commands" collapsible defaultOpen />
    </div>
  );
}

const SCAN_TONE: Record<string, Tone> = { running: 'ok', paused: 'warn', complete: 'info', completed: 'info', cancelled: 'idle', failed: 'bad' };

function SubarrayCard({
  s,
  colour,
  simNow,
  onHighlight,
}: {
  s: SubarrayDTO;
  colour: string;
  simNow: number | null;
  onHighlight: () => void;
}) {
  const target = typeof s.target === 'string' ? s.target : s.target ? 'custom RA/Dec' : null;
  return (
    <section className="arl-panel subarray" style={{ borderLeftColor: colour }}>
      <header className="panel-head">
        <h3>
          <button type="button" className="link" onClick={onHighlight} title="Highlight members on the grid">
            {s.id}
          </button>
        </h3>
        <StatusPill tone={SCAN_TONE[s.scanState ?? ''] ?? 'idle'}>{s.scanState ?? 'Idle'}</StatusPill>
      </header>
      <dl className="dl compact">
        <dt>Target</dt>
        <dd>
          {s.targetName ?? target ?? '—'}
          {s.targetName && target && <span className="muted mono small"> {target}</span>}
        </dd>
        <dt>Band</dt>
        <dd>
          {s.band ? BAND_TEXT[s.band] : '—'}
          {s.observationFrequency && <span className="muted small"> · {fmtNum(s.observationFrequency / 1e9, 3)} GHz</span>}
        </dd>
        <dt>Members</dt>
        <dd>
          {s.health.inService}/{s.health.members} in service
          {s.health.fault > 0 && (
            <>
              {' '}
              <SeverityBadge severity="critical">{s.health.fault} fault</SeverityBadge>
            </>
          )}
          {s.health.stowed > 0 && (
            <>
              {' '}
              <SeverityBadge severity="warning">{s.health.stowed} stowed</SeverityBadge>
            </>
          )}
          {s.health.disabled > 0 && <span className="muted"> · {s.health.disabled} disabled</span>}
          {s.health.offline > 0 && (
            <>
              {' '}
              <SeverityBadge severity="critical">{s.health.offline} offline</SeverityBadge>
            </>
          )}
        </dd>
        <dt>Next scan</dt>
        <dd>{s.nextScan ? `${fmtTs(s.nextScan)} (in ${fmtDuration(s.nextScan - (simNow ?? s.nextScan))})` : '—'}</dd>
      </dl>
      {s.progress != null && (
        <div className="progress" aria-label={`Scan progress ${Math.round(s.progress * 100)}%`}>
          <div className="progress-bar" style={{ width: `${Math.round(s.progress * 100)}%` }} />
          <span>
            {Math.round(s.progress * 100)}%{s.etaS != null ? ` · ETA ${fmtDuration(s.etaS * 1000)}` : ''}
          </span>
        </div>
      )}
      {s.scanId && (
        <Link to={`/rta/scans/${s.scanId}`} className="small">
          {s.scanState === 'running' || s.scanState === 'paused' ? 'Open live scan image' : 'Open last scan'} ({s.scanId}) →
        </Link>
      )}
      <ControlPanel service="rta" entities={[s.id]} kinds={['subarray']} showPresets={s.id === 'main'} collapsible />
    </section>
  );
}

interface Trend {
  from: number;
  to: number;
  minActive: number;
  windStowGustMs: number | null;
  active: { ts: number[]; value: number[] };
  gust: { ts: number[]; value: number[] };
  stowed: { ts: number[]; count: number[] };
  temperature: { ts: number[]; mean: number[]; max: number[] };
  irradiance: { ts: number[]; value: number[] };
}

function Trends() {
  const colours = useThemeColors();
  const [hours, setHours] = useState(6);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<Trend>(`/api/rta/trend?hours=${hours}`)
        .then((t) => alive && (setTrend(t), setError(null)))
        .catch((err) => alive && setError(errorText(err)));
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [hours]);

  const active = useMemo(() => {
    if (!trend) return null;
    const a = alignSeries([
      { ts: [...trend.active.ts, trend.to], v: [...trend.active.value, trend.active.value.at(-1) ?? null] },
      { ts: [trend.from, trend.to], v: [trend.minActive, trend.minActive] },
    ]);
    return { ts: a.ts, values: [holdForward(a.values[0]!), holdForward(a.values[1]!)] };
  }, [trend]);
  const wind = useMemo(() => {
    if (!trend) return null;
    const a = alignSeries([
      { ts: trend.gust.ts, v: trend.gust.value },
      { ts: trend.stowed.ts, v: trend.stowed.count },
      ...(trend.windStowGustMs ? [{ ts: [trend.from, trend.to], v: [trend.windStowGustMs, trend.windStowGustMs] }] : []),
    ]);
    return { ts: a.ts, values: a.values.map((v, i) => (i === 0 ? v : holdForward(v))) };
  }, [trend]);
  const temp = useMemo(() => {
    if (!trend) return null;
    const a = alignSeries([
      { ts: trend.temperature.ts, v: trend.temperature.mean.map((k) => k - 273.15) },
      { ts: trend.temperature.ts, v: trend.temperature.max.map((k) => k - 273.15) },
      { ts: trend.irradiance.ts, v: trend.irradiance.value },
    ]);
    return a;
  }, [trend]);

  return (
    <Panel
      title="Trends"
      actions={
        <div className="seg" role="group" aria-label="Window">
          {[1, 3, 6, 24].map((h) => (
            <button key={h} type="button" className={h === hours ? 'on' : ''} onClick={() => setHours(h)}>
              {h} h
            </button>
          ))}
        </div>
      }
    >
      {error && <ErrorBox>{error}</ErrorBox>}
      {!trend ? (
        <Loading what="trends" />
      ) : (
        <div className="charts">
          <div>
            <h3>Dishes in service vs minimum</h3>
            {active && (
              <Chart
                ts={active.ts}
                values={active.values}
                axes={[{ scale: 'n', label: 'Dishes', range: [0, null] }]}
                series={[
                  { label: 'In service', color: colours.accent, step: true, width: 2 },
                  { label: `Minimum (${trend.minActive})`, color: colours.ink, dash: [6, 4] },
                ]}
              />
            )}
          </div>
          <div>
            <h3>Wind gust (LWM) vs stowed dishes</h3>
            {wind && (
              <Chart
                ts={wind.ts}
                values={wind.values}
                axes={[
                  { scale: 'ms', label: 'Gust m/s', range: [0, null] },
                  { scale: 'n', label: 'Stowed', side: 'right', range: [0, null] },
                ]}
                series={[
                  { label: 'Max gust', color: colours.ochre, scale: 'ms' },
                  { label: 'Stowed dishes', color: colours.sunset, scale: 'n', step: true, width: 2 },
                  ...(trend.windStowGustMs
                    ? [{ label: `Stow limit (${trend.windStowGustMs} m/s)`, color: colours.ink, scale: 'ms', dash: [6, 4] }]
                    : []),
                ]}
              />
            )}
          </div>
          <div>
            <h3>Dish temperature vs irradiance</h3>
            {temp && (
              <Chart
                ts={temp.ts}
                values={temp.values}
                axes={[
                  { scale: 'c', label: '°C' },
                  { scale: 'w', label: 'W/m²', side: 'right', range: [0, null] },
                ]}
                series={[
                  { label: 'Mean dish temp', color: colours.accent, scale: 'c' },
                  { label: 'Max dish temp', color: colours.sunset, scale: 'c', width: 1 },
                  { label: 'Irradiance', color: colours.ochre, scale: 'w' },
                ]}
              />
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
