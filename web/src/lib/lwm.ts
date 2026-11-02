// LWM live view + REST helpers. One SSE channel (`lwm`) carries the whole network snapshot: the five
// sites with their latest readings and derived numbers, the global lightning summary and the recent
// strikes. Everything numeric is computed on the server (see plugins/lwm/derive.ts) and mirrored here
// as read-only types — the page never recomputes a derived value, it just renders and formats it.
import { useState } from 'react';
import { api } from './api';
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
export function useLwmLive(): { network: LwmSnapshot | null; status: SseStatus } {
  const [network, setNetwork] = useState<LwmSnapshot | null>(null);
  const status = useSse('lwm', (env) => {
    const data = env.data as { network?: LwmSnapshot };
    if (env.type === 'snapshot') setNetwork(data.network ?? null);
    else if (env.type === 'patch' && data.network) setNetwork(data.network);
  });
  return { network, status };
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
