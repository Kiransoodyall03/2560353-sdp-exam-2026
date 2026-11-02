// LWM state: five sites plus the service as a whole. The fold is shared by live data and replay, so a
// restored snapshot gives the same numbers the page showed. Backfill samples (buffered readings an
// outage re-published with their original ts) are stored for history but never treated as live: they
// do not move a site's latest reading, its derived numbers or the backfill-in-progress flag the
// recalibration safeguard watches. Field names come from the LWM spec §2.
import type { Parsed } from '../../core/parse.js';

export const SITE_IDS = ['lwm-1', 'lwm-2', 'lwm-3', 'lwm-4', 'lwm-5'] as const;
export type SiteId = (typeof SITE_IDS)[number];

/** Sites carrying an extra instrument stream (LWM spec §1.1). */
export const SONIC_SITE = 'lwm-3';
export const SOILING_SITE = 'lwm-4';
export const PAN_SITE = 'lwm-5';

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

/** One detected strike: distance and bearing from the ARL centre, and which sites saw it. */
export interface LwmStrike {
  ts: number;
  distanceKm: number | null;
  bearingRad: number | null;
  detectedBy: string[];
}

export interface LwmSite {
  id: string;
  // retained state (LWM spec §2.2)
  enabled: boolean | null;
  sampleIntervalS: number | null;
  lastCalibration: number | null;
  lastAnemometerService: number | null;
  lastCleaning: number | null; // lwm-4 only
  lastRefill: number | null; // lwm-5 only
  position: { lat: number; lon: number } | null;
  // latest live readings
  latest: WeatherPoint | null;
  sonic: SonicPoint | null;
  soiling: SoilingPoint | null;
  pan: PanPoint | null;
  /** Live weather samples, oldest first, trimmed to the window the derived numbers need. */
  history: WeatherPoint[];
  /** True while the most recent weather sample seen was a backfill (arrival order). */
  backfilling: boolean;
}

export interface LwmGlobal {
  nearestStrikeKm: number | null;
  strikesLastMin: number | null;
  lightningTs: number | null;
  activeSites: number | null;
  online: boolean | null;
  activeAlerts: string[] | null;
}

export interface LwmState {
  sites: Record<string, LwmSite>;
  global: LwmGlobal;
  /** Recent strikes, oldest first, for the lightning map and the storm-approach numbers. */
  strikes: LwmStrike[];
}

function emptySite(id: string): LwmSite {
  return {
    id,
    enabled: null,
    sampleIntervalS: null,
    lastCalibration: null,
    lastAnemometerService: null,
    lastCleaning: null,
    lastRefill: null,
    position: null,
    latest: null,
    sonic: null,
    soiling: null,
    pan: null,
    history: [],
    backfilling: false,
  };
}

export function emptyLwmState(): LwmState {
  const sites: Record<string, LwmSite> = {};
  for (const id of SITE_IDS) sites[id] = emptySite(id);
  return {
    sites,
    global: {
      nearestStrikeKm: null,
      strikesLastMin: null,
      lightningTs: null,
      activeSites: null,
      online: null,
      activeAlerts: null,
    },
    strikes: [],
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Live weather is kept for this long: enough for the 3 h pressure tendency with room to spare. */
const HISTORY_MS = 4 * 3_600_000;
const MAX_STRIKES = 240;

function weatherPoint(p: { simTs: number; fields: Record<string, unknown> }): WeatherPoint {
  const f = p.fields;
  return {
    ts: p.simTs,
    temperatureK: num(f['temperature_k']),
    humidityPct: num(f['humidity_pct']),
    pressureHpa: num(f['pressure_hpa']),
    windSpeedMs: num(f['wind_speed_ms']),
    windGustMs: num(f['wind_gust_ms']),
    windDirectionRad: num(f['wind_direction_rad']),
    rainfallMm: num(f['rainfall_mm']),
    irradianceWm2: num(f['irradiance_wm2']),
    lightningStrikes: num(f['lightning_strikes']),
    batteryV: num(f['battery_v']),
    status: bool(f['status']),
  };
}

function trimHistory(site: LwmSite): void {
  const newest = site.history[site.history.length - 1]?.ts;
  if (newest === undefined) return;
  const floor = newest - HISTORY_MS;
  let i = 0;
  while (i < site.history.length && site.history[i]!.ts < floor) i++;
  if (i > 0) site.history.splice(0, i);
}

/** Folds one parsed message into the network state; returns true when something the UI shows changed. */
export function reduceLwm(s: LwmState, p: Parsed): boolean {
  if (p.kind === 'telemetry') {
    if (p.stream === 'weather') {
      const site = s.sites[p.entity];
      if (!site) return false;
      if (p.backfill) {
        // buffered sample: recorded for history by the writer, never folded into the live view
        site.backfilling = true;
        return false;
      }
      const point = weatherPoint(p);
      if (site.latest === null || point.ts >= site.latest.ts) site.latest = point;
      site.history.push(point);
      trimHistory(site);
      site.backfilling = false;
      return true;
    }
    if (p.backfill) return false;
    if (p.stream === 'sonic') {
      const site = s.sites[p.entity];
      if (!site) return false;
      const f = p.fields;
      site.sonic = {
        ts: p.simTs,
        windUMs: num(f['wind_u_ms']),
        windVMs: num(f['wind_v_ms']),
        windWMs: num(f['wind_w_ms']),
        turbulenceIntensity: num(f['turbulence_intensity']),
        gustFactor: num(f['gust_factor']),
        directionStdRad: num(f['direction_std_rad']),
        sonicTemperatureK: num(f['sonic_temperature_k']),
      };
      return true;
    }
    if (p.stream === 'soiling') {
      const site = s.sites[p.entity];
      if (!site) return false;
      const f = p.fields;
      site.soiling = {
        ts: p.simTs,
        referenceIrradianceWm2: num(f['reference_irradiance_wm2']),
        exposedIrradianceWm2: num(f['exposed_irradiance_wm2']),
        soilingRatio: num(f['soiling_ratio']),
      };
      return true;
    }
    if (p.stream === 'pan') {
      const site = s.sites[p.entity];
      if (!site) return false;
      const f = p.fields;
      site.pan = { ts: p.simTs, panLevelMm: num(f['pan_level_mm']), evaporationMm: num(f['evaporation_mm']) };
      return true;
    }
    if (p.stream === 'lightning' && p.entity === 'global') {
      const f = p.fields;
      s.global.nearestStrikeKm = num(f['nearest_strike_km']);
      s.global.strikesLastMin = num(f['strikes_last_min']);
      s.global.lightningTs = p.simTs;
      return true;
    }
    return false;
  }

  if (p.kind === 'state') {
    if (p.entity === 'global') {
      switch (p.item) {
        case 'active_sites':
          s.global.activeSites = p.removed ? null : num(p.value);
          return true;
        case 'online':
          s.global.online = p.removed ? null : bool(p.value);
          return true;
        case 'active_alerts':
          s.global.activeAlerts = p.removed
            ? null
            : Array.isArray(p.value)
              ? p.value.filter((x): x is string => typeof x === 'string')
              : null;
          return true;
        default:
          return false;
      }
    }
    const site = s.sites[p.entity];
    if (!site) return false;
    switch (p.item) {
      case 'enabled':
        site.enabled = p.removed ? null : bool(p.value);
        return true;
      case 'sample_interval_s':
        site.sampleIntervalS = p.removed ? null : num(p.value);
        return true;
      case 'last_calibration':
        site.lastCalibration = p.removed ? null : num(p.value);
        return true;
      case 'last_anemometer_service':
        site.lastAnemometerService = p.removed ? null : num(p.value);
        return true;
      case 'last_cleaning':
        site.lastCleaning = p.removed ? null : num(p.value);
        return true;
      case 'last_refill':
        site.lastRefill = p.removed ? null : num(p.value);
        return true;
      case 'position': {
        if (p.removed || typeof p.value !== 'object' || p.value === null) {
          site.position = p.removed ? null : site.position;
          return p.removed;
        }
        const lat = num((p.value as Record<string, unknown>)['lat']);
        const lon = num((p.value as Record<string, unknown>)['lon']);
        if (lat === null || lon === null) return false;
        site.position = { lat, lon };
        return true;
      }
      default:
        return false;
    }
  }

  if (p.kind === 'event' && p.event === 'lightning') {
    const detectedBy = Array.isArray(p.body['detected_by'])
      ? p.body['detected_by'].filter((x): x is string => typeof x === 'string')
      : [];
    s.strikes.push({
      ts: p.simTs,
      distanceKm: num(p.body['distance_km']),
      bearingRad: num(p.body['bearing_rad']),
      detectedBy,
    });
    if (s.strikes.length > MAX_STRIKES) s.strikes.splice(0, s.strikes.length - MAX_STRIKES);
    return true;
  }

  return false;
}
