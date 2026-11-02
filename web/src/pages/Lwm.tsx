// LWM main view: the interpolated weather map (variable + time, so it scrubs in replay), the storm tracker
// card, the impact panel across services, the five site cards in station-model form, a wind rose (per site
// or all sites combined), the lightning scope, the battery forecast, the sonic drift check and the site
// history as small multiples. Everything numeric is computed on the server and streamed on the `lwm`
// channel; the page fetches the map field, the campus outline and per-site history over REST, and every
// control goes through the server pipeline so a refusal reads as the controller's own reason.
import { useEffect, useMemo, useState } from 'react';
import { CommandHistory } from '../components/CommandHistory';
import { Presets } from '../components/ControlPanel';
import { BatteryForecast, type BatteryRow } from '../components/lwm/BatteryForecast';
import { ImpactPanel } from '../components/lwm/ImpactPanel';
import { LightningMap } from '../components/lwm/LightningMap';
import { SiteCards } from '../components/lwm/SiteCards';
import { SiteMultiples } from '../components/lwm/SiteMultiples';
import { SonicDiff } from '../components/lwm/SonicDiff';
import { StormTracker } from '../components/lwm/StormTracker';
import { WeatherMap } from '../components/lwm/WeatherMap';
import { WindRose } from '../components/lwm/WindRose';
import { ErrorBox, KpiTile, Loading, Panel, SeverityBadge, StatusPill } from '../components/ui';
import { errorText } from '../lib/api';
import { fmtNum, fmtTime } from '../lib/format';
import { useReplay } from '../lib/replay';
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
const MAP_SCRUB_MS = 6 * HOUR_MS;
const WINDOWS = [
  { hours: 1, label: '1 h' },
  { hours: 6, label: '6 h' },
  { hours: 24, label: '24 h' },
];
const FALLBACK_VARIABLES = ['temperature_k', 'humidity_pct', 'pressure_hpa', 'wind_speed_ms', 'wind_gust_ms', 'rainfall_mm', 'irradiance_wm2', 'battery_v', 'dew_point_k'];

// The LWM page owns the styles for its own richer visualisations so nothing outside these three files
// changes. Every colour is a design token from tokens.css (rule: no raw hex outside colors.ts); the only
// gradient is the value ramp the WeatherMap legend already draws. Layout uses the shared spacing/radius
// tokens so the section still reads as one surface with the rest of the app.
const LWM_STYLES = `
.storm-tracker { display: flex; flex-direction: column; gap: var(--space-3); }
.storm-tracker .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-2) var(--space-4); margin: 0; }
.storm-tracker .facts > div { display: flex; flex-direction: column; gap: 2px; }
.storm-tracker dt { font: 500 11px/14px var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-muted); }
.storm-tracker dd { margin: 0; font: 500 15px/20px var(--font-data); font-variant-numeric: tabular-nums; color: var(--ink); }
.storm-status { margin: 0; padding: var(--space-2) var(--space-3); background: var(--surface-sunken); border-left: 3px solid var(--accent); color: var(--ink); font: 400 14px/1.4 var(--font-ui); display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; }

.impact-panel { display: flex; flex-direction: column; gap: var(--space-3); }
.impact-row { display: grid; grid-template-columns: 220px 1fr; gap: var(--space-3); align-items: center; }
.impact-label { font: 500 12px/16px var(--font-ui); color: var(--ink-muted); letter-spacing: 0.02em; }
.impact-caption { margin: 0; padding: var(--space-2) var(--space-3); background: var(--surface-sunken); border-left: 3px solid var(--accent); color: var(--ink); font: 400 14px/1.4 var(--font-ui); }
@media (max-width: 720px) { .impact-row { grid-template-columns: 1fr; } }

.site-station .station-model { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--space-2) var(--space-3); margin-top: var(--space-2); padding: var(--space-2); background: var(--surface-sunken); border: 1px solid var(--line); border-radius: var(--radius-1); }
.station-cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.station-cell .kv-k { font: 500 10px/12px var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-muted); }
.station-cell > span:not(.kv-k) { font: 500 14px/18px var(--font-data); font-variant-numeric: tabular-nums; color: var(--ink); }
.station-cell--wind { grid-column: span 2; }
.station-wind { display: inline-flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.site-trend { display: inline-flex; align-items: center; gap: 4px; font: 500 12px/14px var(--font-data); }
.site-battery { display: inline-flex; align-items: center; gap: var(--space-2); }
.site-battery__bar { display: inline-block; width: 60px; height: 8px; background: var(--surface-panel); border: 1px solid var(--line); border-radius: var(--radius-1); overflow: hidden; }
.site-battery__fill { display: block; height: 100%; }
.station-spark { margin-top: var(--space-2); display: flex; flex-direction: column; gap: 4px; }
.site-spark { width: 100%; max-width: 220px; height: 34px; }

.small-multiples { display: flex; flex-direction: column; gap: var(--space-1); }
.small-multiples__svg { width: 100%; height: auto; display: block; }
.sm-title { font: 600 11px/14px var(--font-ui); }
.sm-unit { font: 500 10px/12px var(--font-data); }
.sm-ymax, .sm-ymin, .sm-tick { font: 500 10px/12px var(--font-data); font-variant-numeric: tabular-nums; }

.rose-legend { display: flex; flex-wrap: wrap; gap: var(--space-2); list-style: none; padding: 0; margin: var(--space-1) 0 0; justify-content: center; }
.rose-legend li { display: inline-flex; align-items: center; gap: 4px; }
.rose-swatch { display: inline-block; width: 14px; height: 8px; border-radius: 2px; border: 1px solid var(--line); }
`;

export function LwmPage() {
  const { network, status } = useLwmLive();
  const { isReplaying, t } = useReplay();

  // map: variable + optional scrub time (null = follow the sim clock, so replay advances it)
  const [variable, setVariable] = useState('temperature_k');
  const [variables, setVariables] = useState<string[]>(FALLBACK_VARIABLES);
  const [mapTs, setMapTs] = useState<number | null>(null);
  const [map, setMap] = useState<LwmMapDTO | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [geojson, setGeojson] = useState<unknown | null>(null);

  // While replaying the interpolated field follows the cursor (the server IDWs it as of that sim time);
  // back to live the map resumes "now". Depends only on mode + cursor, so a manual live scrub is not fought.
  useEffect(() => {
    setMapTs(isReplaying ? t : null);
  }, [isReplaying, t]);

  // wind rose scope + window
  const [roseScope, setRoseScope] = useState('all');
  const [roseHours, setRoseHours] = useState(6);

  // site history window + which site
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
  const roseSiteIds = useMemo(() => (siteIds.length ? siteIds : ['lwm-1']), [siteIds]);
  const roseSource = useMemo(() => ({ ids: roseSiteIds, hours: roseHours }), [roseSiteIds, roseHours]);

  const batteryRows: BatteryRow[] = useMemo(
    () => (network?.sites ?? []).map((s) => ({ id: s.id, intervalS: s.sampleIntervalS, online: s.online, battery: s.derived.battery })),
    [network],
  );

  const lwm3 = useMemo(() => network?.sites.find((s) => s.id === 'lwm-3') ?? null, [network]);
  const histSiteDto = useMemo(() => network?.sites.find((s) => s.id === histSite) ?? null, [network, histSite]);

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
  const gustAxis = Math.max(maxGust ?? 0, limits.highWindCritMs) * 1.2;
  const scrubMin = nowTs != null ? nowTs - MAP_SCRUB_MS : 0;
  const scrubMax = nowTs ?? 0;
  const scrubStep = nowTs != null ? Math.max(1000, Math.floor((scrubMax - scrubMin) / 400)) : 1000;
  const scrubbing = mapTs != null;
  const latestStrikeTs = network.strikes.length ? network.strikes[network.strikes.length - 1]!.ts : null;

  return (
    <div className="page">
      <style>{LWM_STYLES}</style>
      <h1>Weather</h1>
      {status !== 'open' && (
        <div className="flag warn">
          <SeverityBadge severity="warning" compact /> Live stream {status}
        </div>
      )}
      {light.withinMaxKm && (
        <div className="flag bad">
          <SeverityBadge severity="critical" compact /> Lightning within {limits.lightningMaxKm} km (
          {light.nearestKm?.toFixed(1)} km): technician visits are blocked.
        </div>
      )}

      <div className="readings">
        <KpiTile
          kpi={{ label: 'Active sites', value: activeSites, unit: `of ${network.sites.length}` }}
          cause={meanTempC == null ? 'Sites reporting to the network now.' : `Mean temperature ${fmtNum(meanTempC, 1)} °C.`}
        />
        <KpiTile
          kpi={{
            label: 'Max gust',
            value: maxGust == null ? null : Math.round(maxGust * 10) / 10,
            unit: 'm/s',
            status: maxGust == null ? undefined : maxGust > limits.highWindCritMs ? 'bad' : maxGust > limits.highWindWarnMs ? 'warn' : 'ok',
          }}
          fill={maxGust == null ? undefined : maxGust / gustAxis}
          limit={{ at: limits.highWindCritMs / gustAxis, label: `Critical ${limits.highWindCritMs} m/s` }}
          cause={`Wind stow starts at ${limits.highWindWarnMs} m/s and the array is critical above ${limits.highWindCritMs} m/s.`}
        />
        <KpiTile
          kpi={{
            label: 'Nearest strike',
            value: light.nearestKm == null ? null : Math.round(light.nearestKm * 10) / 10,
            unit: 'km',
            status: light.withinMaxKm ? 'bad' : light.nearestKm != null && light.nearestKm <= limits.stormApproachKm ? 'warn' : 'ok',
          }}
          cause={
            light.withinMaxKm
              ? `Inside the ${limits.lightningMaxKm} km limit, so technician visits are blocked.`
              : `Visits stay allowed outside ${limits.lightningMaxKm} km; watch from ${limits.stormApproachKm} km.`
          }
        />
        <KpiTile
          kpi={{ label: 'Strikes last minute', value: strikesPerMin, status: strikesPerMin > 0 ? 'warn' : 'ok' }}
          cause={
            strikesPerMin > 0
              ? `${light.strikesLast10Min} strikes in the last ten minutes.`
              : 'No strikes detected in the last minute.'
          }
        />
      </div>

      <Panel
        title="Interpolated field"
        actions={
          <div className="row gap">
            <span className="muted small">{map ? mapVariableLabel(map.variable) : mapVariableLabel(variable)}</span>
            <StatusPill tone={scrubbing ? 'info' : 'ok'}>{scrubbing ? `at ${fmtTime(map?.ts ?? mapTs)}` : 'Live'}</StatusPill>
          </div>
        }
      >
        {mapError && <ErrorBox>{mapError}</ErrorBox>}
        <WeatherMap
          map={map}
          geojson={geojson}
          sites={network.sites}
          lightning={network.strikes}
          limits={limits}
          variable={variable}
          onVariable={setVariable}
          mapTs={mapTs}
          onScrub={setMapTs}
          scrubMin={scrubMin}
          scrubMax={scrubMax}
          scrubStep={scrubStep}
          label={`${mapVariableLabel(variable)} field across the five weather sites`}
        />
        <p className="muted small">
          Inverse-distance interpolation over the five sites{map ? ` at ${fmtTime(map.ts)}` : ''}. The variable switcher, the 60-minute
          time-lapse and the map scrub all work in replay: they ask the server for the field as it was at that moment. Wind arrows
          interpolate the u/v components (never angles); isobars appear when pressure is selected.
        </p>
      </Panel>

      <Panel title="Storm tracker" actions={<span className="muted small">nearest strike, motion and time to the alert radius</span>}>
        <StormTracker strikes={network.strikes} derived={light} limits={limits} now={nowTs} latestStrikeTs={latestStrikeTs} />
      </Panel>

      <Panel title="Sites" actions={<span className="muted small">latest readings, derived numbers and per-site controls</span>}>
        <SiteCards sites={network.sites} now={nowTs} limits={limits} />
      </Panel>

      <div className="lwm-grid">
        <Panel
          title="Wind rose"
          actions={
            <div className="row gap">
              <div className="seg" role="group" aria-label="Wind rose window">
                {WINDOWS.map((w) => (
                  <button key={w.hours} type="button" className={roseHours === w.hours ? 'on' : ''} onClick={() => setRoseHours(w.hours)}>
                    {w.label}
                  </button>
                ))}
              </div>
            </div>
          }
        >
          <WindRose source={roseSource} scope={roseScope} onScopeChange={setRoseScope} siteIds={roseSiteIds} label={`Wind rose over ${roseHours} h`} />
        </Panel>

        <Panel
          title="Lightning"
          actions={
            <StatusPill tone={light.withinMaxKm ? 'bad' : light.strikesLast10Min > 0 ? 'warn' : 'ok'}>
              {light.withinMaxKm ? 'Danger' : light.strikesLast10Min > 0 ? 'Active' : 'Quiet'}
            </StatusPill>
          }
        >
          <LightningMap strikes={network.strikes} limits={limits} derived={light} />
        </Panel>
      </div>

      <Panel title="Weather impact on the other services" actions={<span className="muted small">last 3 h · shared time axis</span>}>
        <ImpactPanel />
      </Panel>

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
            <div className="seg" role="group" aria-label="Window">
              {WINDOWS.map((w) => (
                <button key={w.hours} type="button" className={hours === w.hours ? 'on' : ''} onClick={() => setHours(w.hours)}>
                  {w.label}
                </button>
              ))}
            </div>
          </div>
        }
      >
        {histError && <ErrorBox>{histError}</ErrorBox>}
        {hist && hist.series.ts.length > 1 ? (
          <SiteMultiples hist={hist} site={histSiteDto} hours={hours} />
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
            <dd>{network.global.online == null ? '—' : network.global.online ? 'Yes' : 'No'}</dd>
          </div>
          <div>
            <dt>Active alerts</dt>
            <dd>{network.global.activeAlerts?.length ? network.global.activeAlerts.join(', ') : 'None'}</dd>
          </div>
          <div>
            <dt>Last update</dt>
            <dd className="arl-num">{fmtTime(nowTs)}</dd>
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
