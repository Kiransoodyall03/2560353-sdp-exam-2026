// LWM live view + REST helpers. One SSE channel (`lwm`) carries the whole network snapshot: the five
// sites with their latest readings and derived numbers, the global lightning summary and the recent
// strikes. Everything numeric is computed on the server (see plugins/lwm/derive.ts) and mirrored here
// as read-only types — the page never recomputes a derived value, it just renders and formats it.
import { useState } from 'react';
import { api } from './api';
import { useServiceState } from './service-state';
import { useSse, type SseStatus } from './sse';

// ------------------------------------------------------------------- model
export interface WeatherPoint {
  ts: number;
  temperatureK: number | null;
  humidityPct: number | null;
  pressureHpa: number | null;
  windSpeedMs: number | null;
  windGustMs: number | null;
  windDirectionRad: number | null;
  rainfallMm: number | null;
  irradianceWm2: number | null;
  lightningStrikes: number | null;
  batteryV: number | null;
  status: boolean | null;
}

export interface SonicPoint {
  ts: number;
  windUMs: number | null;
  windVMs: number | null;
  windWMs: number | null;
  turbulenceIntensity: number | null;
  gustFactor: number | null;
  directionStdRad: number | null;
  sonicTemperatureK: number | null;
}

export interface SoilingPoint {
  ts: number;
  referenceIrradianceWm2: number | null;
  exposedIrradianceWm2: number | null;
  soilingRatio: number | null;
}

export interface PanPoint {
  ts: number;
  panLevelMm: number | null;
  evaporationMm: number | null;
}

export interface LwmGlobal {
  nearestStrikeKm: number | null;
  strikesLastMin: number | null;
  lightningTs: number | null;
  activeSites: number | null;
  online: boolean | null;
  activeAlerts: string[] | null;
}

export interface LwmStrike {
  ts: number;
  distanceKm: number | null;
  bearingRad: number | null;
  detectedBy: string[];
}

// ----------------------------------------------------------------- derived
export interface LwmLimits {
  highWindWarnMs: number;
  highWindCritMs: number;
  lightningMaxKm: number;
  stormApproachKm: number;
  temperatureMinK: number;
  temperatureMaxK: number;
  rainMaxMmH: number;
  batteryMinV: number;
  calibrationMaxDays: number;
  soilingMinRatio: number;
  panMinMm: number;
  panMaxMm: number;
}

export interface WindRoseBin {
  deg: number;
  label: string;
  count: number;
  sumSpeedMs: number;
  meanSpeedMs: number | null;
}

export interface BatteryForecast {
  batteryV: number | null;
  drainVph: number | null;
  hoursToMin: number | null;
  minV: number;
}

export interface LwmSiteDerived {
  dewPointK: number | null;
  rainRateMmH: number | null;
  pressureTendencyHpa3h: number | null;
  windRose: WindRoseBin[];
  sonicDeltaK: number | null;
  battery: BatteryForecast;
}

export interface LightningDerived {
  nearestKm: number | null;
  bearingRad: number | null;
  strikesLast10Min: number;
  approachKmh: number | null;
  withinMaxKm: boolean;
}

// -------------------------------------------------------------------- dto
export interface LwmSiteDTO {
  id: string;
  enabled: boolean | null;
  sampleIntervalS: number | null;
  position: { lat: number; lon: number } | null;
  online: boolean;
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

export interface LwmSnapshot {
  sites: LwmSiteDTO[];
  global: LwmGlobal;
  lightning: LightningDerived;
  limits: LwmLimits;
  strikes: LwmStrike[];
  ts: number | null;
}

export interface GridBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

export interface SiteSample {
  id: string;
  lat: number;
  lon: number;
  value: number | null;
}

export interface IdwGrid {
  cols: number;
  rows: number;
  bounds: GridBounds;
  values: (number | null)[];
  min: number | null;
  max: number | null;
  sites: SiteSample[];
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

export interface SonicHistoryRow {
  ts: number;
  windUMs: number | null;
  windVMs: number | null;
  windWMs: number | null;
  turbulenceIntensity: number | null;
  gustFactor: number | null;
  directionStdRad: number | null;
  sonicTemperatureK: number | null;
  backfill: boolean;
}

export interface SoilingHistoryRow {
  ts: number;
  referenceIrradianceWm2: number | null;
  exposedIrradianceWm2: number | null;
  soilingRatio: number | null;
  backfill: boolean;
}

export interface PanHistoryRow {
  ts: number;
  panLevelMm: number | null;
  evaporationMm: number | null;
  backfill: boolean;
}

export interface LightningHistoryRow {
  ts: number;
  distanceKm: number | null;
  bearingRad: number | null;
  detectedBy: string[];
}

export interface LwmSiteHistory {
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

// ------------------------------------------------------------------- live
// While a replay session is active the live channel is closed and the session's folded view ({network}) is
// used instead, so the sites, derived numbers and lightning all reflect the state at the replay cursor.
export function useLwmLive(): { network: LwmSnapshot | null; status: SseStatus } {
  const svc = useServiceState('lwm');
  const [liveNetwork, setNetwork] = useState<LwmSnapshot | null>(null);
  const status = useSse(svc ? null : 'lwm', (env) => {
    const data = env.data as { network?: LwmSnapshot };
    if (env.type === 'snapshot') setNetwork(data.network ?? null);
    else if (env.type === 'patch' && data.network) setNetwork(data.network);
  });
  const network = svc ? ((svc.view as { network?: LwmSnapshot } | null)?.network ?? null) : liveNetwork;
  return { network, status: svc ? 'open' : status };
}

// ------------------------------------------------------------------ fetch
/** The interpolated field for one variable at one sim time (omit `ts` for "now"). */
export function fetchLwmMap(variable: string, ts?: number | null, opts?: { signal?: AbortSignal }): Promise<LwmMapDTO> {
  const q = new URLSearchParams({ var: variable });
  if (ts != null) q.set('ts', String(Math.round(ts)));
  return api.get<LwmMapDTO>(`/api/lwm/map?${q.toString()}`, opts);
}

/** The campus outline (arl.geojson) the map draws underneath the field. */
export function fetchLwmGeoJson(opts?: { signal?: AbortSignal }): Promise<unknown> {
  return api.get<unknown>('/api/lwm/geojson', opts);
}

/** Strike events over a window, oldest first. */
export function fetchLwmLightning(hours = 1, opts?: { signal?: AbortSignal }): Promise<{ strikes: LightningHistoryRow[] }> {
  return api.get<{ strikes: LightningHistoryRow[] }>(`/api/lwm/lightning?hours=${hours}`, opts);
}

/** Per-site sample history (weather + the site's extra stream) over a window. */
export function fetchLwmSiteHistory(id: string, hours = 1, opts?: { signal?: AbortSignal }): Promise<LwmSiteHistory> {
  return api.get<LwmSiteHistory>(`/api/lwm/sites/${encodeURIComponent(id)}/history?hours=${hours}`, opts);
}

/** The variable ids the map can interpolate. */
export function fetchLwmVariables(opts?: { signal?: AbortSignal }): Promise<{ variables: string[] }> {
  return api.get<{ variables: string[] }>('/api/lwm/variables', opts);
}

// ---------------------------------------------------------------- display
/** Human labels for the map variable selector; the server owns the ids and units. */
export const MAP_VARIABLE_LABELS: Record<string, string> = {
  temperature_k: 'Temperature',
  humidity_pct: 'Humidity',
  pressure_hpa: 'Pressure',
  wind_speed_ms: 'Wind speed',
  wind_gust_ms: 'Wind gust',
  rainfall_mm: 'Rainfall',
  irradiance_wm2: 'Irradiance',
  battery_v: 'Battery',
  dew_point_k: 'Dew point',
};

export function mapVariableLabel(id: string): string {
  return MAP_VARIABLE_LABELS[id] ?? id;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Compass point (N, NNE, …) from a bearing in radians clockwise from north. */
export function compassFromRad(rad: number | null | undefined): string | null {
  if (rad == null || !Number.isFinite(rad)) return null;
  const deg = (((rad * 180) / Math.PI) % 360 + 360) % 360;
  return COMPASS[Math.round(deg / 22.5) % 16]!;
}

/** Degrees clockwise from north, 0..360, from a bearing in radians. */
export function degFromRad(rad: number | null | undefined): number | null {
  if (rad == null || !Number.isFinite(rad)) return null;
  return (((rad * 180) / Math.PI) % 360 + 360) % 360;
}

/** Kelvin → "12.3 °C" (weather is displayed in Celsius on the page). */
export function fmtC(k: number | null | undefined, digits = 1): string {
  return k == null || !Number.isFinite(k) ? '—' : `${(k - 273.15).toFixed(digits)} °C`;
}

/** Signed number with a unit, e.g. "+1.2 hPa" / "−0.4 hPa"; an em dash when missing. */
export function fmtSigned(v: number | null | undefined, unit: string, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${s}${Math.abs(v).toFixed(digits)} ${unit}`;
}

// ------------------------------------------------------- client-side field maths
const KM_PER_DEG_LAT = 110.574;

export interface WindUV {
  u: number | null;
  v: number | null;
}

/**
 * Wind vector from the published speed + meteorological FROM bearing (radians clockwise from north):
 * u is the eastward and v the northward component of the airflow, so the vector points where the wind
 * blows *to*. Angles are never interpolated — only these components are.
 */
export function windUVfromSpeedDir(windSpeedMs: number | null | undefined, windDirectionRad: number | null | undefined): WindUV {
  if (windSpeedMs == null || !Number.isFinite(windSpeedMs) || windDirectionRad == null || !Number.isFinite(windDirectionRad)) {
    return { u: null, v: null };
  }
  return { u: -windSpeedMs * Math.sin(windDirectionRad), v: -windSpeedMs * Math.cos(windDirectionRad) };
}

/** Ground distance in km on the planar campus approximation the server IDW uses. */
export function distKm(lat: number, lon: number, sLat: number, sLon: number): number {
  const cosLat = Math.cos((((lat + sLat) / 2) * Math.PI) / 180);
  const dx = (lon - sLon) * KM_PER_DEG_LAT * cosLat;
  const dy = (lat - sLat) * KM_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * IDW at one point over the site samples (weights 1/d²; a site closer than a metre to the point just
 * gives its value) — the same maths the server runs for the coloured field, so the wind arrows and the
 * isobar labels land where the painted field says they should.
 */
export function idwAtPoint(sites: SiteSample[], lat: number, lon: number): number | null {
  let wsum = 0;
  let vsum = 0;
  for (const s of sites) {
    if (s.value == null || !Number.isFinite(s.value) || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const d = distKm(lat, lon, s.lat, s.lon);
    if (d < 1e-6) return s.value;
    const w = 1 / (d * d);
    wsum += w;
    vsum += w * s.value;
  }
  return wsum > 0 ? vsum / wsum : null;
}

/** IDW of the wind components: the mean airflow at the point, interpolated from u/v, never from angles. */
export function windUVAtPoint(sites: { lat: number; lon: number; u: number | null; v: number | null }[], lat: number, lon: number): WindUV & { speedMs: number | null } {
  const u = idwAtPoint(sites.map((s) => ({ id: '', lat: s.lat, lon: s.lon, value: s.u })), lat, lon);
  const v = idwAtPoint(sites.map((s) => ({ id: '', lat: s.lat, lon: s.lon, value: s.v })), lat, lon);
  if (u == null || v == null) return { u: null, v: null, speedMs: null };
  return { u, v, speedMs: Math.hypot(u, v) };
}

/** Lat/lon of grid node (r, c) — the server grid is node-centred, row 0 on the north edge. */
export function nodeLatLng(bounds: GridBounds, cols: number, rows: number, r: number, c: number): { lat: number; lon: number } {
  const lat = rows === 1 ? bounds.maxLat : bounds.maxLat - ((bounds.maxLat - bounds.minLat) * r) / (rows - 1);
  const lon = cols === 1 ? bounds.minLon : bounds.minLon + ((bounds.maxLon - bounds.minLon) * c) / (cols - 1);
  return { lat, lon };
}

/** km per canvas pixel on each axis, for turning alert radii into ring radii. */
export function kmPxScale(bounds: GridBounds, widthPx: number, heightPx: number): { kmPerPxX: number; kmPerPxY: number } {
  const meanLat = (((bounds.minLat + bounds.maxLat) / 2) * Math.PI) / 180;
  const kmLon = (bounds.maxLon - bounds.minLon) * KM_PER_DEG_LAT * Math.cos(meanLat) || 1e-9;
  const kmLat = (bounds.maxLat - bounds.minLat) * KM_PER_DEG_LAT || 1e-9;
  return { kmPerPxX: kmLon / widthPx, kmPerPxY: kmLat / heightPx };
}

export interface ContourLevel {
  level: number;
  /** Cell-local segment endpoints in grid coordinates ([col, row] fractions of the node index). */
  lines: [number, number][][];
}

/**
 * Marching squares over the IDW grid: one segment per cell whose edges cross the level. Cells with a
 * missing value are skipped; the saddle case is resolved by the cell-centre mean. Coordinates come back
 * in node space (col 0..cols-1, row 0..rows-1) so the caller can project them like the field.
 */
export function marchingSquares(grid: IdwGrid, step: number): ContourLevel[] {
  const lo = grid.min;
  const hi = grid.max;
  if (lo == null || hi == null || !(hi > lo) || !(step > 0)) return [];
  const { cols, rows, values } = grid;
  const wanted: number[] = [];
  for (let l = Math.ceil(lo / step) * step; l < hi; l += step) wanted.push(Math.round(l * 1e6) / 1e6);
  if (wanted.length === 0) return [];
  const at = (r: number, c: number): number | null => values[r * cols + c] ?? null;
  const corners: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const out: ContourLevel[] = [];
  for (const level of wanted) {
    const segs: [number, number][][] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const v = [at(r, c), at(r, c + 1), at(r + 1, c + 1), at(r + 1, c)];
        if (v.some((x) => x == null)) continue;
        const vals = v as number[];
        const up = vals.map((x) => (x > level ? 1 : 0));
        const sum = up[0]! + up[1]! + up[2]! + up[3]!;
        if (sum === 0 || sum === 4) continue;
        const crossings: [number, number][] = [];
        for (let i = 0; i < 4; i++) {
          const va = vals[i]!;
          const vb = vals[(i + 1) % 4]!;
          if (va === vb) continue;
          const t = (level - va) / (vb - va);
          const pa = corners[i]!;
          const pb = corners[(i + 1) % 4]!;
          crossings.push([c + pa[0] + (pb[0] - pa[0]) * t, r + pa[1] + (pb[1] - pa[1]) * t]);
        }
        if (crossings.length === 2) {
          segs.push([crossings[0]!, crossings[1]!]);
        } else if (crossings.length === 4) {
          // saddle: the centre value decides which pair of edges joins
          const centreAbove = (vals[0]! + vals[1]! + vals[2]! + vals[3]!) / 4 > level ? 1 : 0;
          if (up[0] === centreAbove) {
            segs.push([crossings[0]!, crossings[1]!]);
            segs.push([crossings[2]!, crossings[3]!]);
          } else {
            segs.push([crossings[0]!, crossings[3]!]);
            segs.push([crossings[1]!, crossings[2]!]);
          }
        }
      }
    }
    if (segs.length > 0) out.push({ level, lines: segs });
  }
  return out;
}

/** Isobar spacing: every 1 hPa, coarsened only when the field spans so much that 1 hPa would blur. */
export function isobarStep(span: number | null): number {
  if (span == null || !(span > 0)) return 1;
  if (span > 60) return 5;
  if (span > 24) return 2;
  return 1;
}

// ---------------------------------------------------------------- wind barb
export interface WindBarbClasses {
  pennants: number;
  full: number;
  half: boolean;
}

/** Classic barb encoding of a wind speed in m/s: pennant 20, full barb 5, half barb 2.5. */
export function windBarbClasses(speedMs: number | null | undefined): WindBarbClasses {
  if (speedMs == null || !Number.isFinite(speedMs) || speedMs < 0) return { pennants: 0, full: 0, half: false };
  let rest = Math.round(speedMs * 2) / 2;
  const pennants = Math.min(2, Math.floor(rest / 20));
  rest -= pennants * 20;
  const full = Math.floor(rest / 5);
  return { pennants, full, half: rest - full * 5 >= 2.5 };
}

/** Below 0.5 m/s the wind is drawn as a calm circle instead of a staff. */
export function isCalmWind(speedMs: number | null | undefined): boolean {
  return speedMs != null && Number.isFinite(speedMs) && speedMs < 0.5;
}

// ------------------------------------------------------------- value formats
/** Format one map-field value for display: kelvin variables arrive as Celsius, everything else as is. */
export function fmtMapValue(variable: string, v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (variable === 'temperature_k' || variable === 'dew_point_k') return `${(v - 273.15).toFixed(digits)} °C`;
  return v.toFixed(digits);
}

// ------------------------------------------------------------- time-lapse
/** Evenly spaced keyframe times covering `spanMs` and ending at `endTs` (inclusive). */
export function timeLapseTimes(endTs: number, count: number, spanMs: number): number[] {
  const n = Math.max(1, Math.floor(count));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round(endTs - spanMs + (spanMs * i) / (n - 1 || 1)));
  return out;
}

