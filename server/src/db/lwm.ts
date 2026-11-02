// LWM persistence: one row per site weather sample (a buffered backfill sample is stored with its
// original ts and flagged, so the map can be rewound to it) plus the site-specific streams and the
// lightning strikes. Interpolation, wind roses and forecasts read from here so replay sees the same
// numbers the live fold produced.
import type { LightningRow, PanRow, SonicRow, SoilingRow, WeatherRow } from '../plugins/lwm/parse.js';
import type { Db } from './index.js';

const NULL_SAFE = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const flag = (v: unknown): boolean => v === 1 || v === true;

export function upsertWeather(db: Db, r: WeatherRow): void {
  db.prepare(
    `INSERT INTO lwm_weather
       (entity, sim_ts, temperature_k, humidity_pct, pressure_hpa, wind_speed_ms, wind_gust_ms,
        wind_direction_rad, rainfall_mm, irradiance_wm2, lightning_strikes, battery_v, status, backfill)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity, sim_ts) DO UPDATE SET
       temperature_k = excluded.temperature_k, humidity_pct = excluded.humidity_pct, pressure_hpa = excluded.pressure_hpa,
       wind_speed_ms = excluded.wind_speed_ms, wind_gust_ms = excluded.wind_gust_ms,
       wind_direction_rad = excluded.wind_direction_rad, rainfall_mm = excluded.rainfall_mm,
       irradiance_wm2 = excluded.irradiance_wm2, lightning_strikes = excluded.lightning_strikes,
       battery_v = excluded.battery_v, status = excluded.status, backfill = excluded.backfill`,
  ).run(
    r.entity,
    r.ts,
    r.temperatureK,
    r.humidityPct,
    r.pressureHpa,
    r.windSpeedMs,
    r.windGustMs,
    r.windDirectionRad,
    r.rainfallMm,
    r.irradianceWm2,
    r.lightningStrikes,
    r.batteryV,
    r.status === null ? null : r.status ? 1 : 0,
    r.backfill ? 1 : 0,
  );
}

export function insertSonic(db: Db, r: SonicRow): void {
  db.prepare(
    `INSERT INTO lwm_sonic
       (sim_ts, wind_u_ms, wind_v_ms, wind_w_ms, turbulence_intensity, gust_factor, direction_std_rad,
        sonic_temperature_k, backfill)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (sim_ts) DO UPDATE SET
       wind_u_ms = excluded.wind_u_ms, wind_v_ms = excluded.wind_v_ms, wind_w_ms = excluded.wind_w_ms,
       turbulence_intensity = excluded.turbulence_intensity, gust_factor = excluded.gust_factor,
       direction_std_rad = excluded.direction_std_rad, sonic_temperature_k = excluded.sonic_temperature_k,
       backfill = excluded.backfill`,
  ).run(r.ts, r.windUMs, r.windVMs, r.windWMs, r.turbulenceIntensity, r.gustFactor, r.directionStdRad, r.sonicTemperatureK, r.backfill ? 1 : 0);
}

export function insertSoiling(db: Db, r: SoilingRow): void {
  db.prepare(
    `INSERT INTO lwm_soiling (sim_ts, reference_irradiance_wm2, exposed_irradiance_wm2, soiling_ratio, backfill)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (sim_ts) DO UPDATE SET
       reference_irradiance_wm2 = excluded.reference_irradiance_wm2, exposed_irradiance_wm2 = excluded.exposed_irradiance_wm2,
       soiling_ratio = excluded.soiling_ratio, backfill = excluded.backfill`,
  ).run(r.ts, r.referenceIrradianceWm2, r.exposedIrradianceWm2, r.soilingRatio, r.backfill ? 1 : 0);
}

export function insertPan(db: Db, r: PanRow): void {
  db.prepare(
    `INSERT INTO lwm_pan (sim_ts, pan_level_mm, evaporation_mm, backfill) VALUES (?, ?, ?, ?)
     ON CONFLICT (sim_ts) DO UPDATE SET
       pan_level_mm = excluded.pan_level_mm, evaporation_mm = excluded.evaporation_mm, backfill = excluded.backfill`,
  ).run(r.ts, r.panLevelMm, r.evaporationMm, r.backfill ? 1 : 0);
}

export function insertLightning(db: Db, r: LightningRow): void {
  db.prepare(
    `INSERT INTO lwm_lightning (sim_ts, distance_km, bearing_rad, detected_by_json) VALUES (?, ?, ?, ?)
     ON CONFLICT (sim_ts) DO UPDATE SET
       distance_km = excluded.distance_km, bearing_rad = excluded.bearing_rad, detected_by_json = excluded.detected_by_json`,
  ).run(r.ts, r.distanceKm, r.bearingRad, JSON.stringify(r.detectedBy));
}

export interface WeatherHistoryRow {
  entity: string;
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
  backfill: boolean;
}

const WEATHER_COLS = `entity, sim_ts, temperature_k, humidity_pct, pressure_hpa, wind_speed_ms, wind_gust_ms,
  wind_direction_rad, rainfall_mm, irradiance_wm2, lightning_strikes, battery_v, status, backfill`;

function mapWeather(r: Record<string, unknown>): WeatherHistoryRow {
  const status = r['status'];
  return {
    entity: String(r['entity']),
    ts: Number(r['sim_ts']),
    temperatureK: NULL_SAFE(r['temperature_k']),
    humidityPct: NULL_SAFE(r['humidity_pct']),
    pressureHpa: NULL_SAFE(r['pressure_hpa']),
    windSpeedMs: NULL_SAFE(r['wind_speed_ms']),
    windGustMs: NULL_SAFE(r['wind_gust_ms']),
    windDirectionRad: NULL_SAFE(r['wind_direction_rad']),
    rainfallMm: NULL_SAFE(r['rainfall_mm']),
    irradianceWm2: NULL_SAFE(r['irradiance_wm2']),
    lightningStrikes: NULL_SAFE(r['lightning_strikes']),
    batteryV: NULL_SAFE(r['battery_v']),
    status: status === null || status === undefined ? null : flag(status),
    backfill: flag(r['backfill']),
  };
}

/** The most recent sample per site at or before `ts` (backfill included): what the map interpolates. */
export function weatherAt(db: Db, ts: number): WeatherHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT ${WEATHER_COLS} FROM lwm_weather w
       WHERE sim_ts = (SELECT MAX(sim_ts) FROM lwm_weather WHERE entity = w.entity AND sim_ts <= ?)
       ORDER BY entity`,
    )
    .all(ts) as Record<string, unknown>[];
  return rows.map(mapWeather);
}

export function loadWeatherFor(db: Db, entity: string, from: number, to: number): WeatherHistoryRow[] {
  const rows = db
    .prepare(`SELECT ${WEATHER_COLS} FROM lwm_weather WHERE entity = ? AND sim_ts >= ? AND sim_ts <= ? ORDER BY sim_ts`)
    .all(entity, from, to) as Record<string, unknown>[];
  return rows.map(mapWeather);
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

export function loadSonic(db: Db, from: number, to: number): SonicHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT sim_ts, wind_u_ms, wind_v_ms, wind_w_ms, turbulence_intensity, gust_factor, direction_std_rad,
        sonic_temperature_k, backfill FROM lwm_sonic WHERE sim_ts >= ? AND sim_ts <= ? ORDER BY sim_ts`,
    )
    .all(from, to) as Record<string, unknown>[];
  return rows.map((r) => ({
    ts: Number(r['sim_ts']),
    windUMs: NULL_SAFE(r['wind_u_ms']),
    windVMs: NULL_SAFE(r['wind_v_ms']),
    windWMs: NULL_SAFE(r['wind_w_ms']),
    turbulenceIntensity: NULL_SAFE(r['turbulence_intensity']),
    gustFactor: NULL_SAFE(r['gust_factor']),
    directionStdRad: NULL_SAFE(r['direction_std_rad']),
    sonicTemperatureK: NULL_SAFE(r['sonic_temperature_k']),
    backfill: flag(r['backfill']),
  }));
}

export interface SoilingHistoryRow {
  ts: number;
  referenceIrradianceWm2: number | null;
  exposedIrradianceWm2: number | null;
  soilingRatio: number | null;
  backfill: boolean;
}

export function loadSoiling(db: Db, from: number, to: number): SoilingHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT sim_ts, reference_irradiance_wm2, exposed_irradiance_wm2, soiling_ratio, backfill
       FROM lwm_soiling WHERE sim_ts >= ? AND sim_ts <= ? ORDER BY sim_ts`,
    )
    .all(from, to) as Record<string, unknown>[];
  return rows.map((r) => ({
    ts: Number(r['sim_ts']),
    referenceIrradianceWm2: NULL_SAFE(r['reference_irradiance_wm2']),
    exposedIrradianceWm2: NULL_SAFE(r['exposed_irradiance_wm2']),
    soilingRatio: NULL_SAFE(r['soiling_ratio']),
    backfill: flag(r['backfill']),
  }));
}

export interface PanHistoryRow {
  ts: number;
  panLevelMm: number | null;
  evaporationMm: number | null;
  backfill: boolean;
}

export function loadPan(db: Db, from: number, to: number): PanHistoryRow[] {
  const rows = db
    .prepare(`SELECT sim_ts, pan_level_mm, evaporation_mm, backfill FROM lwm_pan WHERE sim_ts >= ? AND sim_ts <= ? ORDER BY sim_ts`)
    .all(from, to) as Record<string, unknown>[];
  return rows.map((r) => ({
    ts: Number(r['sim_ts']),
    panLevelMm: NULL_SAFE(r['pan_level_mm']),
    evaporationMm: NULL_SAFE(r['evaporation_mm']),
    backfill: flag(r['backfill']),
  }));
}

export interface LightningHistoryRow {
  ts: number;
  distanceKm: number | null;
  bearingRad: number | null;
  detectedBy: string[];
}

export function loadLightning(db: Db, from: number, to: number): LightningHistoryRow[] {
  const rows = db
    .prepare(`SELECT sim_ts, distance_km, bearing_rad, detected_by_json FROM lwm_lightning WHERE sim_ts >= ? AND sim_ts <= ? ORDER BY sim_ts`)
    .all(from, to) as Record<string, unknown>[];
  return rows.map((r) => {
    let detectedBy: string[] = [];
    try {
      const parsed = JSON.parse(String(r['detected_by_json'] ?? '[]')) as unknown;
      if (Array.isArray(parsed)) detectedBy = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      detectedBy = [];
    }
    return { ts: Number(r['sim_ts']), distanceKm: NULL_SAFE(r['distance_km']), bearingRad: NULL_SAFE(r['bearing_rad']), detectedBy };
  });
}
