// Derived weather numbers. Nothing here is published by the simulator: the dew point, hourly rain
// rate, 3 h pressure tendency, wind rose, storm approach and battery forecast are all computed from
// the samples the five sites send (LWM spec §2, §4). Pure functions over LwmState so the same code
// serves the live page, the KPIs and the unit tests.
import { SITE_IDS, SONIC_SITE, type LwmSite, type LwmState, type WeatherPoint } from './model.js';

// ------------------------------------------------------------------- limits
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

/** Defaults from the LWM spec §4 alert limits, used when the API has not published them yet. */
export const DEFAULT_LWM_LIMITS: LwmLimits = {
  highWindWarnMs: 15,
  highWindCritMs: 20,
  lightningMaxKm: 10,
  stormApproachKm: 25,
  temperatureMinK: 268,
  temperatureMaxK: 313,
  rainMaxMmH: 10,
  batteryMinV: 11.5,
  calibrationMaxDays: 30,
  soilingMinRatio: 0.95,
  panMinMm: 175,
  panMaxMm: 230,
};

/**
 * Maps /v1/alert-limits/lwm onto LwmLimits. The RTA client publishes bare dotted keys; be tolerant of
 * a `lwm.`-prefixed variant too, and fall back to the spec default so the numbers survive a cold cache.
 */
export function lwmLimitsFrom(list: { key: string; value: number }[] | null): LwmLimits {
  const m = new Map((list ?? []).map((l) => [l.key, l.value]));
  const g = (k: string, d: number): number => {
    const bare = m.get(k);
    if (typeof bare === 'number' && Number.isFinite(bare)) return bare;
    const prefixed = m.get(`lwm.${k}`);
    if (typeof prefixed === 'number' && Number.isFinite(prefixed)) return prefixed;
    return d;
  };
  return {
    highWindWarnMs: g('high_wind.warn_ms', DEFAULT_LWM_LIMITS.highWindWarnMs),
    highWindCritMs: g('high_wind.crit_ms', DEFAULT_LWM_LIMITS.highWindCritMs),
    lightningMaxKm: g('lightning.max_km', DEFAULT_LWM_LIMITS.lightningMaxKm),
    stormApproachKm: g('storm.approach_km', DEFAULT_LWM_LIMITS.stormApproachKm),
    temperatureMinK: g('temperature.min_k', DEFAULT_LWM_LIMITS.temperatureMinK),
    temperatureMaxK: g('temperature.max_k', DEFAULT_LWM_LIMITS.temperatureMaxK),
    rainMaxMmH: g('rain.max_mm_h', DEFAULT_LWM_LIMITS.rainMaxMmH),
    batteryMinV: g('battery.min_v', DEFAULT_LWM_LIMITS.batteryMinV),
    calibrationMaxDays: g('calibration.max_days', DEFAULT_LWM_LIMITS.calibrationMaxDays),
    soilingMinRatio: g('soiling.min_ratio', DEFAULT_LWM_LIMITS.soilingMinRatio),
    panMinMm: g('pan.min_mm', DEFAULT_LWM_LIMITS.panMinMm),
    panMaxMm: g('pan.max_mm', DEFAULT_LWM_LIMITS.panMaxMm),
  };
}

// ------------------------------------------------------------------ helpers
const HOUR_MS = 3_600_000;
const RAIN_WINDOW_MS = HOUR_MS;
const PRESSURE_WINDOW_MS = 3 * HOUR_MS;
/** How close a sample must be to the 3 h mark to count as the pressure-tendency baseline. */
const PRESSURE_TOL_MS = 20 * 60_000;
const LIGHTNING_COUNT_MS = 10 * 60_000;
const LIGHTNING_TREND_MS = 15 * 60_000;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const ROSE_BINS = 16;
const BIN_DEG = 360 / ROSE_BINS;

/** Least-squares slope of `v` against time, per hour; null with fewer than two points or a flat axis. */
function slopePerHour(pts: { ts: number; v: number }[]): number | null {
  const n = pts.length;
  if (n < 2) return null;
  const t0 = pts[0]!.ts;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    const x = (p.ts - t0) / HOUR_MS;
    sx += x;
    sy += p.v;
    sxx += x * x;
    sxy += x * p.v;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return (n * sxy - sx * sy) / denom;
}

function nearestPoint(history: WeatherPoint[], targetTs: number): WeatherPoint | null {
  let best: WeatherPoint | null = null;
  let bestD = Infinity;
  for (const p of history) {
    const d = Math.abs(p.ts - targetTs);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Degrees clockwise from north (0..360) from a meteorological FROM bearing in radians. */
export function bearingToDeg(rad: number): number {
  const deg = (rad * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

// ---------------------------------------------------------------- dew point
/**
 * Dew point by the Magnus formula (Sonntag constants): γ = ln(RH/100) + bT/(c+T), Td = cγ/(b−γ) with
 * T in °C. Null when either input is missing or the humidity is out of range (ln undefined at 0).
 */
export function dewPointK(temperatureK: number | null, humidityPct: number | null): number | null {
  if (temperatureK === null || humidityPct === null) return null;
  if (!(humidityPct > 0) || humidityPct > 100) return null;
  const b = 17.625;
  const c = 243.04;
  const t = temperatureK - 273.15;
  const gamma = Math.log(humidityPct / 100) + (b * t) / (c + t);
  const denom = b - gamma;
  if (denom === 0) return null;
  return (c * gamma) / denom + 273.15;
}

// --------------------------------------------------------------- rain rate
/** Rainfall over the last hour, mm/h: rainfall_mm is the depth since the previous sample, so it sums. */
export function rainRateMmH(history: WeatherPoint[]): number | null {
  const latest = history[history.length - 1];
  if (!latest) return null;
  const from = latest.ts - RAIN_WINDOW_MS;
  let sum = 0;
  let saw = false;
  for (const p of history) {
    if (p.ts <= from) continue;
    if (p.rainfallMm === null) continue;
    sum += p.rainfallMm;
    saw = true;
  }
  return saw ? sum : null;
}

// -------------------------------------------------------- pressure tendency
/** Pressure change over the last 3 h, hPa/3h: latest minus the sample nearest the 3 h mark. */
export function pressureTendencyHpa3h(history: WeatherPoint[]): number | null {
  const latest = history[history.length - 1];
  if (!latest || latest.pressureHpa === null) return null;
  const target = latest.ts - PRESSURE_WINDOW_MS;
  const old = nearestPoint(history, target);
  if (!old || old.pressureHpa === null) return null;
  if (Math.abs(old.ts - target) > PRESSURE_TOL_MS) return null; // not enough history yet
  return latest.pressureHpa - old.pressureHpa;
}

// ----------------------------------------------------------------- wind rose
export interface WindRoseBin {
  /** Bin centre, degrees clockwise from north. */
  deg: number;
  /** Compass label (N, NNE, …). */
  label: string;
  /** Samples that fell in the bin. */
  count: number;
  /** Sum of wind_speed_ms: the rose radius weights each direction by how hard it blew. */
  sumSpeedMs: number;
  /** Mean wind_speed_ms in the bin (null when empty). */
  meanSpeedMs: number | null;
}

/** Wind rose over the live history: 16 direction bins weighted by wind_speed_ms. */
export function windRose(history: WeatherPoint[]): WindRoseBin[] {
  const bins: WindRoseBin[] = [];
  for (let i = 0; i < ROSE_BINS; i++) {
    bins.push({ deg: i * BIN_DEG, label: COMPASS[i]!, count: 0, sumSpeedMs: 0, meanSpeedMs: null });
  }
  for (const p of history) {
    if (p.windDirectionRad === null || p.windSpeedMs === null) continue;
    const idx = Math.round(bearingToDeg(p.windDirectionRad) / BIN_DEG) % ROSE_BINS;
    const bin = bins[idx]!;
    bin.count += 1;
    bin.sumSpeedMs += p.windSpeedMs;
  }
  for (const bin of bins) bin.meanSpeedMs = bin.count ? bin.sumSpeedMs / bin.count : null;
  return bins;
}

// ------------------------------------------------------------ sonic vs main
/** Sonic anemometer temperature minus the main thermometer, K (lwm-3 only): a drift check. */
export function sonicDeltaK(site: LwmSite): number | null {
  const sonic = site.sonic?.sonicTemperatureK ?? null;
  const main = site.latest?.temperatureK ?? null;
  if (sonic === null || main === null) return null;
  return sonic - main;
}

// ------------------------------------------------------------ battery drain
export interface BatteryForecast {
  batteryV: number | null;
  /** Measured drain, V per hour (negative while discharging); reflects the current sample interval. */
  drainVph: number | null;
  /** Hours until the battery reaches minV at the current drain (null when flat or charging). */
  hoursToMin: number | null;
  minV: number;
}

/**
 * Battery drain from the site's own voltage history: a site sampling every 10 s runs its battery down
 * faster than one at 600 s, and the slope of battery_v against time captures exactly that. The forecast
 * is how long the pack lasts before it crosses the battery.min_v alert limit.
 */
export function batteryForecast(history: WeatherPoint[], minV: number): BatteryForecast {
  const latest = history[history.length - 1];
  const batteryV = latest?.batteryV ?? null;
  const pts = history.filter((p) => p.batteryV !== null).map((p) => ({ ts: p.ts, v: p.batteryV as number }));
  const drainVph = slopePerHour(pts);
  let hoursToMin: number | null = null;
  if (batteryV !== null && drainVph !== null && drainVph < 0 && batteryV > minV) {
    hoursToMin = (batteryV - minV) / -drainVph;
  }
  return { batteryV, drainVph, hoursToMin, minV };
}

// ---------------------------------------------------------------- lightning
export interface LightningDerived {
  /** Nearest strike in the last 10 min, km from the ARL centre (falls back to the published summary). */
  nearestKm: number | null;
  /** Bearing of that nearest strike, radians clockwise from north. */
  bearingRad: number | null;
  /** Strikes detected in the last 10 min. */
  strikesLast10Min: number;
  /** Positive when the storm is closing in (km/h), from the trend of the nearest distance. */
  approachKmh: number | null;
  /** True while a strike is inside lightning.max_km. */
  withinMaxKm: boolean;
}

/** Nearest strike, its bearing, the recent rate and the approach speed, all from the strike events. */
export function lightningSummary(state: LwmState, limits: LwmLimits): LightningDerived {
  const strikes = state.strikes;
  const now = strikes.length ? strikes[strikes.length - 1]!.ts : state.global.lightningTs;
  const published = state.global.nearestStrikeKm;
  if (now === null) {
    return {
      nearestKm: published,
      bearingRad: null,
      strikesLast10Min: state.global.strikesLastMin ?? 0,
      approachKmh: null,
      withinMaxKm: published !== null && published <= limits.lightningMaxKm,
    };
  }
  const recent = strikes.filter((s) => s.ts > now - LIGHTNING_COUNT_MS);
  let nearestKm: number | null = null;
  let bearingRad: number | null = null;
  for (const s of recent) {
    if (s.distanceKm === null) continue;
    if (nearestKm === null || s.distanceKm < nearestKm) {
      nearestKm = s.distanceKm;
      bearingRad = s.bearingRad;
    }
  }
  if (nearestKm === null) nearestKm = published;
  const trend = strikes
    .filter((s) => s.ts > now - LIGHTNING_TREND_MS && s.distanceKm !== null)
    .map((s) => ({ ts: s.ts, v: s.distanceKm as number }));
  const slope = slopePerHour(trend); // km/h, negative while the distance shrinks
  return {
    nearestKm,
    bearingRad,
    strikesLast10Min: recent.length,
    approachKmh: slope === null ? null : -slope,
    withinMaxKm: nearestKm !== null && nearestKm <= limits.lightningMaxKm,
  };
}

// ------------------------------------------------------------ per-site view
export interface LwmSiteDerived {
  dewPointK: number | null;
  rainRateMmH: number | null;
  pressureTendencyHpa3h: number | null;
  windRose: WindRoseBin[];
  /** Sonic vs main thermometer delta (lwm-3 only). */
  sonicDeltaK: number | null;
  battery: BatteryForecast;
}

export interface LwmDerived {
  sites: Record<string, LwmSiteDerived>;
  lightning: LightningDerived;
}

function deriveSite(site: LwmSite, limits: LwmLimits): LwmSiteDerived {
  const latest = site.latest;
  return {
    dewPointK: latest ? dewPointK(latest.temperatureK, latest.humidityPct) : null,
    rainRateMmH: rainRateMmH(site.history),
    pressureTendencyHpa3h: pressureTendencyHpa3h(site.history),
    windRose: windRose(site.history),
    sonicDeltaK: site.id === SONIC_SITE ? sonicDeltaK(site) : null,
    battery: batteryForecast(site.history, limits.batteryMinV),
  };
}

/** All derived numbers for the network, from the live folded state. */
export function deriveLwm(state: LwmState, limits: LwmLimits = DEFAULT_LWM_LIMITS): LwmDerived {
  const sites: Record<string, LwmSiteDerived> = {};
  for (const id of SITE_IDS) {
    const site = state.sites[id];
    if (site) sites[id] = deriveSite(site, limits);
  }
  return { sites, lightning: lightningSummary(state, limits) };
}
