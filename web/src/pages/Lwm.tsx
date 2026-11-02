// LWM main view: the interpolated weather map (variable + time, so it scrubs in replay), the five site
// cards with their controls, a wind rose, the lightning scope, the battery forecast and the sonic drift
// check. Everything numeric is computed on the server and streamed on the `lwm` channel; the page fetches
// the map field, the campus outline and per-site history over REST, and every control goes through the
// server pipeline so a refusal reads as the controller's own reason.
import { useEffect, useMemo, useState } from 'react';
import { Chart, type ChartAxis, type ChartSeries } from '../components/Chart';
import { CommandHistory } from '../components/CommandHistory';
import { Presets } from '../components/ControlPanel';
import { BatteryForecast, type BatteryRow } from '../components/lwm/BatteryForecast';
import { LightningMap } from '../components/lwm/LightningMap';
import { SiteCards } from '../components/lwm/SiteCards';
import { SonicDiff } from '../components/lwm/SonicDiff';
import { WeatherMap } from '../components/lwm/WeatherMap';
import { WindRose } from '../components/lwm/WindRose';
import { ErrorBox, KpiTile, Loading, Panel, StatusPill } from '../components/ui';
import { errorText } from '../lib/api';
import { fmtNum, fmtTime } from '../lib/format';
import {
  fetchLwmGeoJson,
  fetchLwmMap,
  fetchLwmSiteHistory,
  fetchLwmVariables,
  mapVariableLabel,
  useLwmLive,
  type LwmMapDTO,
  type LwmSiteHistory,
} from '../lib/lwm';

const HOUR_MS = 3_600_000;
const WINDOWS = [
  { hours: 1, label: '1 h' },
  { hours: 6, label: '6 h' },
  { hours: 24, label: '24 h' },
];
const FALLBACK_VARIABLES = ['temperature_k', 'humidity_pct', 'pressure_hpa', 'wind_speed_ms', 'wind_gust_ms', 'rainfall_mm', 'irradiance_wm2', 'battery_v', 'dew_point_k'];

export function LwmPage() {
  const { network, status } = useLwmLive();

  // map: variable + optional scrub time (null = follow the sim clock, so replay advances it)
  const [variable, setVariable] = useState('temperature_k');
  const [variables, setVariables] = useState<string[]>(FALLBACK_VARIABLES);
  const [mapTs, setMapTs] = useState<number | null>(null);
  const [map, setMap] = useState<LwmMapDTO | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [geojson, setGeojson] = useState<unknown | null>(null);

  // wind rose + site history share the window selector
  const [roseSite, setRoseSite] = useState('lwm-1');
  const [histSite, setHistSite] = useState('lwm-3');
  const [hours, setHours] = useState(1);
  const [hist, setHist] = useState<LwmSiteHistory | null>(null);
  const [histError, setHistError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchLwmVariables()
      .then((r) => alive && r.variables.length && setVariables(r.variables))
      .catch(() => {
        /* the fallback list is already in state */
      });
    fetchLwmGeoJson()
      .then((g) => alive && setGeojson(g))
      .catch(() => {
        /* the map draws the field without the outline */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    const load = () =>
      fetchLwmMap(variable, mapTs, { signal: ac.signal })
        .then((m) => {
          if (!alive) return;
          setMap(m);
          setMapError(null);
        })
        .catch((err: unknown) => {
          if (alive && (err as Error).name !== 'AbortError') setMapError(errorText(err));
        });
    void load();
    const timer = mapTs == null ? setInterval(() => void load(), 10_000) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      ac.abort();
    };
  }, [variable, mapTs]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchLwmSiteHistory(histSite, hours)
        .then((h) => {
          if (!alive) return;
          setHist(h);
          setHistError(null);
        })
        .catch((err: unknown) => alive && setHistError(errorText(err)));
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [histSite, hours]);

  const siteIds = useMemo(() => (network ? network.sites.map((s) => s.id) : []), [network]);
  const roseBins = useMemo(() => network?.sites.find((s) => s.id === roseSite)?.derived.windRose ?? [], [network, roseSite]);

  const batteryRows: BatteryRow[] = useMemo(
    () => (network?.sites ?? []).map((s) => ({ id: s.id, intervalS: s.sampleIntervalS, online: s.online, battery: s.derived.battery })),
    [network],
  );

  const lwm3 = useMemo(() => network?.sites.find((s) => s.id === 'lwm-3') ?? null, [network]);

  // align the sonic temperature against the nearest main-thermometer reading for the drift trend
  const sonicSeries = useMemo(() => {
    if (!hist || hist.site !== 'lwm-3' || !hist.sonic) return null;
    const wTs = hist.series.ts;
    const wT = hist.series.temperatureK;
    const ts: number[] = [];
    const deltaK: (number | null)[] = [];
    for (const row of hist.sonic) {
      if (row.sonicTemperatureK == null) continue;
      let best: number | null = null;
      let bestD = Infinity;
      for (let i = 0; i < wTs.length; i++) {
        const d = Math.abs(wTs[i]! - row.ts);
        if (d < bestD) {
          bestD = d;
          best = wT[i] ?? null;
        }
      }
      if (best == null) continue;
      ts.push(row.ts);
      deltaK.push(row.sonicTemperatureK - best);
    }
    return ts.length > 1 ? { ts, deltaK } : null;
  }, [hist]);

  const histSeries = useMemo(() => {
    if (!hist) return null;
    const s = hist.series;
    const toC = (v: (number | null)[]) => v.map((k) => (k == null ? null : k - 273.15));
    return {
      ts: s.ts,
      tempWind: [toC(s.temperatureK), s.windSpeedMs, s.windGustMs],
      pressBatt: [s.pressureHpa, s.batteryV],
    };
  }, [hist]);

  if (!network) return <Loading what="weather network" />;

  const limits = network.limits;
  const light = network.lightning;
  const gusts = network.sites.map((s) => s.latest?.windGustMs).filter((g): g is number => g != null);
  const maxGust = gusts.length ? Math.max(...gusts) : null;
  const temps = network.sites.map((s) => s.latest?.temperatureK).filter((t): t is number => t != null);
  const meanTempC = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length - 273.15 : null;
  const activeSites = network.global.activeSites ?? network.sites.filter((s) => s.enabled !== false).length;
  const strikesPerMin = network.global.strikesLastMin ?? light.strikesLast10Min;

  const nowTs = network.ts;
  const scrubMin = nowTs != null ? nowTs - hours * HOUR_MS : 0;
  const scrubMax = nowTs ?? 0;
  const scrubStep = nowTs != null ? Math.max(1000, Math.floor((scrubMax - scrubMin) / 400)) : 1000;
  const scrubbing = mapTs != null;

  return (
    <div className="page">
      <h1>Weather</h1>
      {status !== 'open' && <div className="flag warn">◆ Live stream {status}</div>}
      {light.withinMaxKm && (
        <div className="flag bad blink">
          ▲ Lightning within {limits.lightningMaxKm} km ({light.nearestKm?.toFixed(1)} km): technician visits are blocked.
        </div>
      )}

      <div className="kpis wide">
        <KpiTile kpi={{ label: 'Active sites', value: activeSites }} />
        <KpiTile
          kpi={{
            label: 'Max gust',
            value: maxGust == null ? null : Math.round(maxGust * 10) / 10,
            unit: 'm/s',
            status: maxGust == null ? undefined : maxGust > limits.highWindCritMs ? 'bad' : maxGust > limits.highWindWarnMs ? 'warn' : 'ok',
          }}
        />
        <KpiTile kpi={{ label: 'Mean temp', value: meanTempC == null ? null : Math.round(meanTempC * 10) / 10, unit: '°C' }} />
        <KpiTile kpi={{ label: 'Strikes/min', value: strikesPerMin, status: strikesPerMin > 0 ? 'warn' : 'ok' }} />
        <KpiTile
          kpi={{
            label: 'Nearest strike',
            value: light.nearestKm == null ? null : Math.round(light.nearestKm * 10) / 10,
            unit: 'km',
            status: light.withinMaxKm ? 'bad' : light.nearestKm != null && light.nearestKm <= limits.stormApproachKm ? 'warn' : 'ok',
          }}
        />
      </div>

      <Panel
        title="Interpolated field"
        actions={
          <div className="row gap">
            <label className="field-inline">
              <span className="muted small">Variable</span>
              <select value={variable} onChange={(e) => setVariable(e.target.value)}>
                {variables.map((v) => (
                  <option key={v} value={v}>
                    {mapVariableLabel(v)}
                  </option>
                ))}
              </select>
            </label>
            <StatusPill tone={scrubbing ? 'info' : 'ok'}>{scrubbing ? `at ${fmtTime(map?.ts ?? mapTs)}` : 'live'}</StatusPill>
          </div>
        }
      >
        <div className="row gap map-scrub">
          <input
            type="range"
            min={scrubMin}
            max={scrubMax}
            step={scrubStep}
            value={mapTs ?? scrubMax}
            disabled={nowTs == null}
            onChange={(e) => setMapTs(Number(e.target.value))}
            aria-label="Map time"
          />
          <button type="button" className={scrubbing ? 'primary' : undefined} onClick={() => setMapTs(null)} disabled={!scrubbing}>
            Live
          </button>
        </div>
        {mapError && <ErrorBox>{mapError}</ErrorBox>}
        {map ? (
          <WeatherMap map={map} geojson={geojson} label={`${mapVariableLabel(map.variable)} field across the five weather sites`} />
        ) : (
          <Loading what="weather field" />
        )}
        <p className="muted small">
          Inverse-distance interpolation over the five sites{map ? ` at ${fmtTime(map.ts)}` : ''}. Drag the slider to rewind into the
          buffered history — the field is rebuilt from whatever each site last reported at that moment.
        </p>
      </Panel>

      <Panel title="Sites" actions={<span className="muted small">latest readings, derived numbers and per-site controls</span>}>
        <SiteCards sites={network.sites} now={nowTs} limits={limits} />
      </Panel>

      <div className="lwm-grid">
        <Panel
          title="Wind rose"
          actions={
            <select value={roseSite} onChange={(e) => setRoseSite(e.target.value)} aria-label="Wind rose site">
              {(siteIds.length ? siteIds : ['lwm-1']).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          }
        >
          <WindRose bins={roseBins} label={`Wind rose for ${roseSite}`} />
        </Panel>

        <Panel
          title="Lightning"
          actions={<StatusPill tone={light.withinMaxKm ? 'bad' : light.strikesLast10Min > 0 ? 'warn' : 'ok'}>{light.withinMaxKm ? 'danger' : light.strikesLast10Min > 0 ? 'active' : 'quiet'}</StatusPill>}
        >
          <LightningMap strikes={network.strikes} limits={limits} derived={light} />
        </Panel>
      </div>

      <div className="lwm-grid">
        <Panel title="Battery forecast" actions={<span className="muted small">drain vs sample interval</span>}>
          <BatteryForecast sites={batteryRows} />
        </Panel>

        <Panel title="Sonic vs main thermometer" actions={<StatusPill tone="info">lwm-3</StatusPill>}>
          <SonicDiff
            sonic={lwm3?.sonic ?? null}
            temperatureK={lwm3?.latest?.temperatureK ?? null}
            deltaK={lwm3?.derived.sonicDeltaK ?? null}
            series={sonicSeries}
          />
        </Panel>
      </div>

      <Panel
        title="Site history"
        actions={
          <div className="row gap">
            <select value={histSite} onChange={(e) => setHistSite(e.target.value)} aria-label="History site">
              {(siteIds.length ? siteIds : ['lwm-1']).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            {WINDOWS.map((w) => (
              <button key={w.hours} type="button" className={hours === w.hours ? 'primary' : undefined} onClick={() => setHours(w.hours)}>
                {w.label}
              </button>
            ))}
          </div>
        }
      >
        {histError && <ErrorBox>{histError}</ErrorBox>}
        {hist && histSeries && histSeries.ts.length > 1 ? (
          <div className="charts">
            <div>
              <h3>Temperature & wind</h3>
              <SiteChart ts={histSeries.ts} values={histSeries.tempWind} labels={['°C', 'wind', 'gust']} colors={['#f0b429', '#4cc9f0', '#e05c5c']} axes={[{ scale: 'y', label: '°C' }, { scale: 'y2', label: 'm/s', side: 'right' }]} scales={['y', 'y2', 'y2']} />
            </div>
            <div>
              <h3>Pressure & battery</h3>
              <SiteChart ts={histSeries.ts} values={histSeries.pressBatt} labels={['pressure', 'battery']} colors={['#94a3b8', '#38c172']} axes={[{ scale: 'y', label: 'hPa' }, { scale: 'y2', label: 'V', side: 'right' }]} scales={['y', 'y2']} />
            </div>
          </div>
        ) : (
          <p className="muted small">Not enough samples in this window yet.</p>
        )}
      </Panel>

      <Panel title="Network controls" actions={<span className="muted small">presets set the sample interval on all five sites at once</span>}>
        <Presets service="lwm" />
        <p className="muted small">
          Per-site controls (enable, sample interval, recalibration, anemometer service, and on lwm-4/lwm-5 the reference-cell cleaning
          and pan refill) are on each site card above. Every command is verified server-side; a refusal is shown with the controller's
          own reason.
        </p>
      </Panel>

      <Panel title="Command history" actions={<span className="muted small">every command is verified before it is published</span>}>
        <CommandHistory service="lwm" limit={15} />
      </Panel>

      <Panel title="Network" actions={<span className="muted small">service-level state</span>}>
        <dl className="facts">
          <div>
            <dt>Online</dt>
            <dd>{network.global.online == null ? '—' : network.global.online ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Active alerts</dt>
            <dd>{network.global.activeAlerts?.length ? network.global.activeAlerts.join(', ') : 'none'}</dd>
          </div>
          <div>
            <dt>Last update</dt>
            <dd className="mono">{fmtTime(nowTs)}</dd>
          </div>
          <div>
            <dt>Nearest strike</dt>
            <dd>{light.nearestKm == null ? '—' : `${fmtNum(light.nearestKm, 1)} km`}</dd>
          </div>
        </dl>
      </Panel>
    </div>
  );
}

// A tiny wrapper so the two history charts share their series/axis wiring.
function SiteChart({
  ts,
  values,
  labels,
  colors,
  axes,
  scales,
}: {
  ts: number[];
  values: (number | null)[][];
  labels: string[];
  colors: string[];
  axes: ChartAxis[];
  scales: string[];
}) {
  const series: ChartSeries[] = labels.map((label, i) => ({ label, color: colors[i]!, scale: scales[i] }));
  return <Chart ts={ts} values={values} series={series} axes={axes} height={200} />;
}
