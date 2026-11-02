// LWM plugin: typed parse, reducer-backed state over the five sites, weather/sonic/soiling/pan/lightning
// persistence, the derived numbers (dew point, rain rate, pressure tendency, wind rose, battery, storm
// approach), the IDW map, controls/presets, and SSE + REST. Mirrors the OPG/RTA plugin shape.
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ServiceTopology } from '../../../../shared/types.js';
import type { AlertLimit } from '../../arl-api/client.js';
import type { CommandSpec, PresetSpec } from '../../commands/types.js';
import type { Parsed } from '../../core/parse.js';
import {
  insertLightning,
  insertPan,
  insertSonic,
  insertSoiling,
  loadLightning,
  loadPan,
  loadSoiling,
  loadSonic,
  loadWeatherFor,
  upsertWeather,
  weatherAt,
  type LightningHistoryRow,
  type PanHistoryRow,
  type SoilingHistoryRow,
  type SonicHistoryRow,
} from '../../db/lwm.js';
import type { Db } from '../../db/index.js';
import { lwmRoutes } from '../../routes/lwm.js';
import { defaultExpectation } from '../generic.js';
import type { Kpi, PlatformContext, Plugin, StreamExpectation } from '../types.js';
import { lwmCommandSpecs, lwmPresets, type LwmControlView } from './controls.js';
import {
  DEFAULT_LWM_LIMITS,
  deriveLwm,
  dewPointK,
  lwmLimitsFrom,
  type LightningDerived,
  type LwmDerived,
  type LwmLimits,
  type LwmSiteDerived,
} from './derive.js';
import {
  boundsFromGeoJson,
  boundsFromSites,
  idwGrid,
  siteSamples,
  type GridBounds,
  type IdwGrid,
} from './interpolate.js';
import {
  emptyLwmState,
  reduceLwm,
  SITE_IDS,
  SOILING_SITE,
  SONIC_SITE,
  PAN_SITE,
  type LwmGlobal,
  type LwmSite,
  type LwmState,
  type PanPoint,
  type SonicPoint,
  type SoilingPoint,
  type WeatherPoint,
} from './model.js';
import { lightningRow, panRow, parseLwm, sonicRow, soilingRow, weatherRow } from './parse.js';

const HOUR_MS = 3_600_000;
const ENTITY_IDS = new Set<string>([...SITE_IDS, 'global']);
const GEOJSON_URL = new URL('../../../../docs/assets/arl.geojson', import.meta.url);
const MAX_SNAPSHOT_STRIKES = 120;
const MAX_HISTORY_POINTS = 1500;

/** The variables the map can interpolate; dew point is derived, the rest come straight off a sample. */
const MAP_VARIABLES: Record<string, { unit: string; pick: (r: { temperatureK: number | null; humidityPct: number | null; pressureHpa: number | null; windSpeedMs: number | null; windGustMs: number | null; rainfallMm: number | null; irradianceWm2: number | null; batteryV: number | null }) => number | null }> = {
  temperature_k: { unit: 'K', pick: (r) => r.temperatureK },
  humidity_pct: { unit: '%', pick: (r) => r.humidityPct },
  pressure_hpa: { unit: 'hPa', pick: (r) => r.pressureHpa },
  wind_speed_ms: { unit: 'm/s', pick: (r) => r.windSpeedMs },
  wind_gust_ms: { unit: 'm/s', pick: (r) => r.windGustMs },
  rainfall_mm: { unit: 'mm', pick: (r) => r.rainfallMm },
  irradiance_wm2: { unit: 'W/m²', pick: (r) => r.irradianceWm2 },
  battery_v: { unit: 'V', pick: (r) => r.batteryV },
  dew_point_k: { unit: 'K', pick: (r) => dewPointK(r.temperatureK, r.humidityPct) },
};
export const MAP_VARIABLE_IDS = Object.keys(MAP_VARIABLES);

export interface LwmSiteDTO {
  id: string;
  enabled: boolean | null;
  sampleIntervalS: number | null;
  position: { lat: number; lon: number } | null;
  online: boolean;
  /** True while the last sample seen was a buffered backfill (the recalibration safeguard watches it). */
  backfilling: boolean;
  latest: WeatherPoint | null;
  sonic: SonicPoint | null;
  soiling: SoilingPoint | null;
  pan: PanPoint | null;
  lastCalibration: number | null;
  lastAnemometerService: number | null;
  lastCleaning: number | null;
  lastRefill: number | null;
  derived: LwmSiteDerived;
}

export interface LwmSnapshotDTO {
  sites: LwmSiteDTO[];
  global: LwmGlobal;
  lightning: LightningDerived;
  limits: LwmLimits;
  /** Recent strike events for the lightning map, oldest first. */
  strikes: { ts: number; distanceKm: number | null; bearingRad: number | null; detectedBy: string[] }[];
  ts: number | null;
}

export interface LwmMapDTO {
  variable: string;
  unit: string;
  ts: number;
  bounds: GridBounds;
  grid: IdwGrid;
  min: number | null;
  max: number | null;
}

export interface LwmSiteHistoryDTO {
  site: string;
  from: number;
  to: number;
  series: {
    ts: number[];
    temperatureK: (number | null)[];
    humidityPct: (number | null)[];
    pressureHpa: (number | null)[];
    windSpeedMs: (number | null)[];
    windGustMs: (number | null)[];
    windDirectionRad: (number | null)[];
    rainfallMm: (number | null)[];
    irradianceWm2: (number | null)[];
    batteryV: (number | null)[];
  };
  sonic?: SonicHistoryRow[];
  soiling?: SoilingHistoryRow[];
  pan?: PanHistoryRow[];
}

export class LwmPlugin implements Plugin {
  readonly id = 'lwm' as const;
  state: LwmState = emptyLwmState();
  private ctx!: PlatformContext;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private specs: CommandSpec[] | null = null;
  /** Site geometry from $topology, overridden by the retained `position` state when it arrives. */
  private positions: Record<string, { lat: number; lon: number }> = {};
  private geoBounds: GridBounds | null = null;
  private geojson: unknown | null = null;
  private geoPromise: Promise<void> | null = null;

  // ------------------------------------------------------------ controls
  private readonly controlView: LwmControlView = {
    state: this.state,
    derived: () => deriveLwm(this.state, this.limits()),
    limits: () => this.limits(),
  };

  get commands(): CommandSpec[] {
    return (this.specs ??= lwmCommandSpecs(this.controlView));
  }

  get presets(): PresetSpec[] {
    return lwmPresets();
  }

  parse(topic: string, payload: Buffer, recvTs: number, retained: boolean): Parsed[] {
    return parseLwm(topic, payload, recvTs, retained);
  }

  init(ctx: PlatformContext): void {
    this.ctx = ctx;
    ctx.sse.register('lwm', () => ({ network: this.network() }));
    this.timer = setInterval(() => this.flushViews(), 500);
    this.timer.unref?.();
    void this.ensureGeo();
  }

  onTopology(t: ServiceTopology): void {
    for (const e of t.entities) {
      if (typeof e.lat === 'number' && typeof e.lon === 'number') this.positions[e.id] = { lat: e.lat, lon: e.lon };
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------ fold + persist
  derive(p: Parsed): void {
    if (reduceLwm(this.state, p)) this.dirty = true;
  }

  persist(batch: Parsed[], db: Db): void {
    for (const p of batch) {
      if (p.kind === 'telemetry') {
        if (p.stream === 'weather') {
          const r = weatherRow(p);
          if (r) upsertWeather(db, r);
        } else if (p.stream === 'sonic') {
          const r = sonicRow(p);
          if (r) insertSonic(db, r);
        } else if (p.stream === 'soiling') {
          const r = soilingRow(p);
          if (r) insertSoiling(db, r);
        } else if (p.stream === 'pan') {
          const r = panRow(p);
          if (r) insertPan(db, r);
        }
        continue;
      }
      if (p.kind === 'event' && p.event === 'lightning') {
        const r = lightningRow(p);
        if (r) insertLightning(db, r);
      }
    }
  }

  expectations(entity: { id: string; kind: string }): StreamExpectation | null {
    if (!ENTITY_IDS.has(entity.id)) return null;
    return defaultExpectation('lwm', entity, this.ctx.topology, this.ctx.state);
  }

  limits(): LwmLimits {
    return lwmLimitsFrom(this.ctx?.api.peek<AlertLimit[]>('limits|lwm') ?? null);
  }

  kpis(): Kpi[] {
    const l = this.limits();
    const light = deriveLwm(this.state, l).lightning;
    let maxGust: number | null = null;
    const temps: number[] = [];
    for (const id of SITE_IDS) {
      const s = this.state.sites[id];
      if (!s) continue;
      const g = s.latest?.windGustMs;
      if (g !== null && g !== undefined && (maxGust === null || g > maxGust)) maxGust = g;
      const t = s.latest?.temperatureK;
      if (t !== null && t !== undefined) temps.push(t);
    }
    const activeSites = this.state.global.activeSites ?? SITE_IDS.filter((id) => this.state.sites[id]?.enabled !== false).length;
    const strikesPerMin = this.state.global.strikesLastMin ?? light.strikesLast10Min;
    return [
      { label: 'Active sites', value: activeSites },
      {
        label: 'Max gust',
        value: maxGust === null ? null : Math.round(maxGust * 10) / 10,
        unit: 'm/s',
        status: maxGust === null ? undefined : maxGust > l.highWindCritMs ? 'bad' : maxGust > l.highWindWarnMs ? 'warn' : 'ok',
      },
      {
        label: 'Mean temp',
        value: temps.length ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length - 273.15) * 10) / 10 : null,
        unit: '°C',
      },
      { label: 'Strikes/min', value: strikesPerMin, status: strikesPerMin > 0 ? 'warn' : 'ok' },
      {
        label: 'Nearest strike',
        value: light.nearestKm === null ? null : Math.round(light.nearestKm * 10) / 10,
        unit: 'km',
        status: light.withinMaxKm ? 'bad' : light.nearestKm !== null && light.nearestKm <= l.stormApproachKm ? 'warn' : 'ok',
      },
    ];
  }

  private simNow(): number | null {
    return this.ctx?.clock.now('lwm') ?? null;
  }

  // ------------------------------------------------------------ geometry
  /** Site positions: the retained `position` state wins, the topology is the fallback. */
  positionsOf(): Record<string, { lat: number; lon: number }> {
    const out: Record<string, { lat: number; lon: number }> = { ...this.positions };
    for (const id of SITE_IDS) {
      const p = this.state.sites[id]?.position;
      if (p) out[id] = { lat: p.lat, lon: p.lon };
    }
    return out;
  }

  /** Loads arl.geojson once (campus outline for the map + its bounds). Safe to call repeatedly. */
  ensureGeo(): Promise<void> {
    return (this.geoPromise ??= this.loadGeo());
  }

  private async loadGeo(): Promise<void> {
    try {
      const buf = await readFile(GEOJSON_URL);
      const gj = JSON.parse(buf.toString('utf8')) as unknown;
      this.geojson = gj;
      this.geoBounds = boundsFromGeoJson(gj);
      this.dirty = true;
    } catch (err) {
      this.ctx?.log?.warn({ err }, 'lwm: arl.geojson load failed; map falls back to the site bounds');
    }
  }

  geojsonDoc(): unknown {
    return this.geojson;
  }

  mapBounds(): GridBounds | null {
    return this.geoBounds;
  }

  // ------------------------------------------------------------ views
  private siteOnline(site: LwmSite): boolean {
    if (site.latest === null) return false;
    const now = this.simNow();
    if (now === null) return true;
    const interval = (site.sampleIntervalS ?? 60) * 1000;
    return now - site.latest.ts <= 3 * interval;
  }

  private siteDTO(site: LwmSite, derived: LwmSiteDerived | undefined): LwmSiteDTO {
    const pos = this.positionsOf()[site.id] ?? site.position ?? null;
    return {
      id: site.id,
      enabled: site.enabled,
      sampleIntervalS: site.sampleIntervalS,
      position: pos,
      online: this.siteOnline(site),
      backfilling: site.backfilling,
      latest: site.latest,
      sonic: site.id === SONIC_SITE ? site.sonic : null,
      soiling: site.id === SOILING_SITE ? site.soiling : null,
      pan: site.id === PAN_SITE ? site.pan : null,
      lastCalibration: site.lastCalibration,
      lastAnemometerService: site.lastAnemometerService,
      lastCleaning: site.lastCleaning,
      lastRefill: site.lastRefill,
      derived: derived ?? {
        dewPointK: null,
        rainRateMmH: null,
        pressureTendencyHpa3h: null,
        windRose: [],
        sonicDeltaK: null,
        battery: { batteryV: null, drainVph: null, hoursToMin: null, minV: DEFAULT_LWM_LIMITS.batteryMinV },
      },
    };
  }

  network(): LwmSnapshotDTO {
    const limits = this.limits();
    const derived: LwmDerived = deriveLwm(this.state, limits);
    const sites = SITE_IDS.map((id) => this.state.sites[id]!)
      .filter((s): s is LwmSite => !!s)
      .map((s) => this.siteDTO(s, derived.sites[s.id]));
    let ts: number | null = null;
    for (const s of sites) if (s.latest && (ts === null || s.latest.ts > ts)) ts = s.latest.ts;
    if (this.state.global.lightningTs !== null && (ts === null || this.state.global.lightningTs > ts)) ts = this.state.global.lightningTs;
    return {
      sites,
      global: this.state.global,
      lightning: derived.lightning,
      limits,
      strikes: this.state.strikes.slice(-MAX_SNAPSHOT_STRIKES),
      ts,
    };
  }

  /** IDW field for one variable at one sim time (defaults to now); reads the persisted samples so replay scrubs. */
  map(variable: string, ts: number | null, cols = 48, rows = 40): LwmMapDTO {
    const v = MAP_VARIABLES[variable] ?? MAP_VARIABLES['temperature_k']!;
    const at = ts ?? this.simNow() ?? Date.now();
    this.ctx.flush();
    const rowsDb = weatherAt(this.ctx.db, at);
    const samples = siteSamples(rowsDb, v.pick, this.positionsOf());
    const bounds = this.geoBounds ?? boundsFromSites(samples) ?? { minLon: 0, maxLon: 1, minLat: 0, maxLat: 1 };
    const grid = idwGrid(samples, bounds, cols, rows);
    return { variable: MAP_VARIABLES[variable] ? variable : 'temperature_k', unit: v.unit, ts: at, bounds, grid, min: grid.min, max: grid.max };
  }

  /** Strike events over a window, from the persisted lightning rows (so replay sees the same storm). */
  strikes(hours = 1): LightningHistoryRow[] {
    this.ctx.flush();
    const to = this.simNow() ?? Date.now();
    const from = to - hours * HOUR_MS;
    return loadLightning(this.ctx.db, from, to);
  }

  siteHistory(id: string, hours: number): LwmSiteHistoryDTO | null {
    if (!ENTITY_IDS.has(id) || id === 'global') return null;
    this.ctx.flush();
    const db = this.ctx.db;
    const to = this.simNow() ?? Date.now();
    const from = to - hours * HOUR_MS;
    const rows = loadWeatherFor(db, id, from, to);
    const stride = Math.max(1, Math.ceil(rows.length / MAX_HISTORY_POINTS));
    const series: LwmSiteHistoryDTO['series'] = {
      ts: [],
      temperatureK: [],
      humidityPct: [],
      pressureHpa: [],
      windSpeedMs: [],
      windGustMs: [],
      windDirectionRad: [],
      rainfallMm: [],
      irradianceWm2: [],
      batteryV: [],
    };
    for (let i = 0; i < rows.length; i += stride) {
      const r = rows[i]!;
      series.ts.push(r.ts);
      series.temperatureK.push(r.temperatureK);
      series.humidityPct.push(r.humidityPct);
      series.pressureHpa.push(r.pressureHpa);
      series.windSpeedMs.push(r.windSpeedMs);
      series.windGustMs.push(r.windGustMs);
      series.windDirectionRad.push(r.windDirectionRad);
      series.rainfallMm.push(r.rainfallMm);
      series.irradianceWm2.push(r.irradianceWm2);
      series.batteryV.push(r.batteryV);
    }
    const out: LwmSiteHistoryDTO = { site: id, from, to, series };
    if (id === SONIC_SITE) out.sonic = loadSonic(db, from, to);
    if (id === SOILING_SITE) out.soiling = loadSoiling(db, from, to);
    if (id === PAN_SITE) out.pan = loadPan(db, from, to);
    return out;
  }

  private flushViews(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.ctx.sse.patch('lwm', 'network', this.network());
  }

  snapshot(): unknown {
    return { network: this.network() };
  }

  routes(app: FastifyInstance): void {
    lwmRoutes(app, this);
  }
}

export function createLwmPlugin(): LwmPlugin {
  return new LwmPlugin();
}
