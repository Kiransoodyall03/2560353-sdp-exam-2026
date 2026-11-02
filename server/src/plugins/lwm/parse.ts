// LWM parsing: the shared envelope parser plus the network's own view of each stream. Field names come
// from the LWM spec §2; a measurement that cannot be taken is null (the spec allows it), not an error.
// The row builders keep the backfill flag so the writer stores a buffered sample with its original ts.
import { z } from 'zod';
import { parseMessage, type Parsed, type ParsedEvent, type ParsedTelemetry } from '../../core/parse.js';

const Num = z.number().finite().nullable().optional();
const Bool = z.boolean().nullable().optional();

const WeatherFields = z
  .object({
    temperature_k: Num,
    humidity_pct: Num,
    pressure_hpa: Num,
    wind_speed_ms: Num,
    wind_gust_ms: Num,
    wind_direction_rad: Num,
    rainfall_mm: Num,
    irradiance_wm2: Num,
    lightning_strikes: Num,
    battery_v: Num,
    status: Bool,
    backfill: Bool,
  })
  .passthrough();

const SonicFields = z
  .object({
    wind_u_ms: Num,
    wind_v_ms: Num,
    wind_w_ms: Num,
    turbulence_intensity: Num,
    gust_factor: Num,
    direction_std_rad: Num,
    sonic_temperature_k: Num,
    backfill: Bool,
  })
  .passthrough();

const SoilingFields = z
  .object({
    reference_irradiance_wm2: Num,
    exposed_irradiance_wm2: Num,
    soiling_ratio: Num,
    backfill: Bool,
  })
  .passthrough();

const PanFields = z
  .object({
    pan_level_mm: Num,
    evaporation_mm: Num,
    backfill: Bool,
  })
  .passthrough();

const LightningSummary = z
  .object({
    nearest_strike_km: Num,
    strikes_last_min: Num,
  })
  .passthrough();

const LightningEvent = z
  .object({
    distance_km: Num,
    bearing_rad: Num,
    detected_by: z.array(z.string()).optional(),
  })
  .passthrough();

/** The telemetry streams the network publishes (lightning is the global summary). */
export const LWM_STREAMS = ['weather', 'sonic', 'soiling', 'pan', 'lightning'] as const;
export type LwmStream = (typeof LWM_STREAMS)[number];

/** Someone else's topics are dropped: the platform routes by service, this is the second guard. */
export function parseLwm(topic: string, payload: Buffer, recvTs: number, retained: boolean): Parsed[] {
  if (topic.split('/')[1] !== 'lwm') return [];
  return [parseMessage(topic, payload, recvTs, retained)];
}

export interface WeatherRow {
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

export interface SonicRow {
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

export interface SoilingRow {
  ts: number;
  referenceIrradianceWm2: number | null;
  exposedIrradianceWm2: number | null;
  soilingRatio: number | null;
  backfill: boolean;
}

export interface PanRow {
  ts: number;
  panLevelMm: number | null;
  evaporationMm: number | null;
  backfill: boolean;
}

export interface LightningRow {
  ts: number;
  distanceKm: number | null;
  bearingRad: number | null;
  detectedBy: string[];
}

/** True when the message is a well-formed sample of one of the network's telemetry streams. */
export function isLwmSample(p: Parsed): p is ParsedTelemetry {
  if (p.kind !== 'telemetry') return false;
  if (!(LWM_STREAMS as readonly string[]).includes(p.stream)) return false;
  return sampleOf(p) !== null;
}

/** Validated fields of a telemetry sample, or null when the payload is not a documented shape. */
export function sampleOf(p: ParsedTelemetry): Record<string, number | boolean | null> | null {
  const schema =
    p.stream === 'weather'
      ? WeatherFields
      : p.stream === 'sonic'
        ? SonicFields
        : p.stream === 'soiling'
          ? SoilingFields
          : p.stream === 'pan'
            ? PanFields
            : p.stream === 'lightning'
              ? LightningSummary
              : null;
  if (!schema) return null;
  const r = schema.safeParse(p.fields);
  if (!r.success) return null;
  const out: Record<string, number | boolean | null> = {};
  for (const [k, v] of Object.entries(r.data as Record<string, unknown>)) {
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? v : null;
  }
  return out;
}

const n = (f: Record<string, number | boolean | null>, k: string): number | null =>
  typeof f[k] === 'number' ? (f[k] as number) : null;
const b = (f: Record<string, number | boolean | null>, k: string): boolean | null =>
  typeof f[k] === 'boolean' ? (f[k] as boolean) : null;

/** The weather row a sample contributes (backfill kept, so it lands with its original ts). */
export function weatherRow(p: ParsedTelemetry): WeatherRow | null {
  if (p.stream !== 'weather') return null;
  const f = sampleOf(p);
  if (!f) return null;
  return {
    entity: p.entity,
    ts: p.simTs,
    temperatureK: n(f, 'temperature_k'),
    humidityPct: n(f, 'humidity_pct'),
    pressureHpa: n(f, 'pressure_hpa'),
    windSpeedMs: n(f, 'wind_speed_ms'),
    windGustMs: n(f, 'wind_gust_ms'),
    windDirectionRad: n(f, 'wind_direction_rad'),
    rainfallMm: n(f, 'rainfall_mm'),
    irradianceWm2: n(f, 'irradiance_wm2'),
    lightningStrikes: n(f, 'lightning_strikes'),
    batteryV: n(f, 'battery_v'),
    status: b(f, 'status'),
    backfill: p.backfill,
  };
}

export function sonicRow(p: ParsedTelemetry): SonicRow | null {
  if (p.stream !== 'sonic') return null;
  const f = sampleOf(p);
  if (!f) return null;
  return {
    ts: p.simTs,
    windUMs: n(f, 'wind_u_ms'),
    windVMs: n(f, 'wind_v_ms'),
    windWMs: n(f, 'wind_w_ms'),
    turbulenceIntensity: n(f, 'turbulence_intensity'),
    gustFactor: n(f, 'gust_factor'),
    directionStdRad: n(f, 'direction_std_rad'),
    sonicTemperatureK: n(f, 'sonic_temperature_k'),
    backfill: p.backfill,
  };
}

export function soilingRow(p: ParsedTelemetry): SoilingRow | null {
  if (p.stream !== 'soiling') return null;
  const f = sampleOf(p);
  if (!f) return null;
  return {
    ts: p.simTs,
    referenceIrradianceWm2: n(f, 'reference_irradiance_wm2'),
    exposedIrradianceWm2: n(f, 'exposed_irradiance_wm2'),
    soilingRatio: n(f, 'soiling_ratio'),
    backfill: p.backfill,
  };
}

export function panRow(p: ParsedTelemetry): PanRow | null {
  if (p.stream !== 'pan') return null;
  const f = sampleOf(p);
  if (!f) return null;
  return { ts: p.simTs, panLevelMm: n(f, 'pan_level_mm'), evaporationMm: n(f, 'evaporation_mm'), backfill: p.backfill };
}

/** A detected strike event → the row the lightning map is drawn from. */
export function lightningRow(p: ParsedEvent): LightningRow | null {
  if (p.event !== 'lightning') return null;
  const r = LightningEvent.safeParse(p.body);
  if (!r.success) return null;
  return {
    ts: p.simTs,
    distanceKm: typeof r.data.distance_km === 'number' ? r.data.distance_km : null,
    bearingRad: typeof r.data.bearing_rad === 'number' ? r.data.bearing_rad : null,
    detectedBy: r.data.detected_by ?? [],
  };
}
