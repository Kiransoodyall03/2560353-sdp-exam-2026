// P5: LWM parsing (five sites + sonic/soiling/pan/lightning), the buffered-backfill handling, the
// derived weather numbers, the IDW map field, the persistence the replay scrubs, and the safeguards.
import { describe, expect, it } from 'vitest';
import { fixture, memDb } from './helpers.js';
import {
  insertLightning,
  loadLightning,
  loadWeatherFor,
  upsertWeather,
  weatherAt,
  type WeatherHistoryRow,
} from '../src/db/lwm.js';
import { lwmCommandSpecs, lwmPresets, REFILL_NOT_NEEDED_MM, type LwmControlView } from '../src/plugins/lwm/controls.js';
import {
  batteryForecast,
  bearingToDeg,
  DEFAULT_LWM_LIMITS,
  deriveLwm,
  dewPointK,
  lightningSummary,
  lwmLimitsFrom,
  pressureTendencyHpa3h,
  rainRateMmH,
  sonicDeltaK,
  windRose,
  type LwmLimits,
} from '../src/plugins/lwm/derive.js';
import { boundsFromGeoJson, boundsFromSites, idwGrid, siteSamples, type GridBounds } from '../src/plugins/lwm/interpolate.js';
import { emptyLwmState, reduceLwm, SITE_IDS, type LwmState, type WeatherPoint } from '../src/plugins/lwm/model.js';
import { isLwmSample, lightningRow, panRow, parseLwm, sampleOf, sonicRow, soilingRow, weatherRow } from '../src/plugins/lwm/parse.js';
import type { CommandSpec } from '../src/commands/types.js';
import type { Parsed, ParsedEvent, ParsedTelemetry } from '../src/core/parse.js';

const T = 1_793_602_860_000; // the fixture's first simulated minute
const MIN = 60_000;
const HOUR = 3_600_000;

const msg = (topic: string, payload: unknown): Parsed => parseLwm(topic, Buffer.from(JSON.stringify(payload)), T, false)[0]!;
const tel = (topic: string, payload: unknown): ParsedTelemetry => msg(topic, payload) as ParsedTelemetry;

/** A weather sample on one site; `backfill: true` marks a buffered reading replayed with its original ts. */
const weatherMsg = (entity: string, fields: Record<string, unknown>, ts = T): ParsedTelemetry =>
  tel(`arl/lwm/${entity}/telemetry/weather`, { v: 1, ts, seq: 1, entity, ...fields });

/** A detected strike event, as the network publishes it on arl/lwm/events/lightning. */
const strikeMsg = (fields: Record<string, unknown>, ts = T): ParsedEvent =>
  msg('arl/lwm/events/lightning', { v: 1, ts, entity: 'global', ...fields }) as ParsedEvent;

/** A bare weather point for the pure derive functions (no envelope, no fold). */
const w = (ts: number, over: Partial<WeatherPoint> = {}): WeatherPoint => ({
  ts,
  temperatureK: null,
  humidityPct: null,
  pressureHpa: null,
  windSpeedMs: null,
  windGustMs: null,
  windDirectionRad: null,
  rainfallMm: null,
  irradianceWm2: null,
  lightningStrikes: null,
  batteryV: null,
  status: null,
  ...over,
});

/** A persisted weather row, for the interpolation and history tests. */
const whr = (entity: string, over: Partial<WeatherHistoryRow> = {}): WeatherHistoryRow => ({
  entity,
  ts: T,
  temperatureK: null,
  humidityPct: null,
  pressureHpa: null,
  windSpeedMs: null,
  windGustMs: null,
  windDirectionRad: null,
  rainfallMm: null,
  irradianceWm2: null,
  lightningStrikes: null,
  batteryV: null,
  status: null,
  backfill: false,
  ...over,
});

// ------------------------------------------------------------------ parser
describe('lwm parse', () => {
  it('drops other services (the platform routes by service, this is the second guard)', () => {
    expect(parseLwm('arl/opg/solar/telemetry/power', Buffer.from('{}'), T, false)).toEqual([]);
  });

  it('accepts every network stream from the recorded fixture', () => {
    const samples = fixture('lwm-opg.txt')
      .flatMap((l) => parseLwm(l.topic, Buffer.from(l.payload), T, false))
      .filter(isLwmSample);
    expect(samples.filter((s) => s.stream === 'weather')).toHaveLength(5);
    expect(new Set(samples.map((s) => s.stream))).toEqual(new Set(['weather', 'sonic', 'soiling', 'pan', 'lightning']));
  });

  it('reads the five sites out of the first recorded minute', () => {
    const rows = fixture('lwm-opg.txt')
      .slice(0, 9)
      .flatMap((l) => parseLwm(l.topic, Buffer.from(l.payload), T, false))
      .filter(isLwmSample)
      .filter((p) => p.stream === 'weather')
      .map((p) => weatherRow(p)!);
    expect(rows.map((r) => r.entity)).toEqual(['lwm-1', 'lwm-2', 'lwm-3', 'lwm-4', 'lwm-5']);
    expect(rows[0]!.temperatureK).toBeCloseTo(284.84, 6);
    expect(rows[0]!.backfill).toBe(false);
  });

  it('treats a measurement that cannot be taken as null instead of rejecting the sample', () => {
    const p = tel('arl/lwm/lwm-1/telemetry/weather', { v: 1, ts: T, entity: 'lwm-1', temperature_k: 285 });
    expect(isLwmSample(p)).toBe(true);
    const row = weatherRow(p)!;
    expect(row.temperatureK).toBe(285);
    expect(row.humidityPct).toBeNull();
    expect(row.windGustMs).toBeNull();
  });

  it('rejects a sample whose documented field has the wrong type', () => {
    const p = tel('arl/lwm/lwm-1/telemetry/weather', { v: 1, ts: T, entity: 'lwm-1', temperature_k: 'warm' });
    expect(isLwmSample(p)).toBe(false);
    expect(sampleOf(p)).toBeNull();
  });

  it('keeps the backfill flag so a buffered sample lands with its original ts', () => {
    expect(weatherRow(weatherMsg('lwm-2', { temperature_k: 280 }))!.backfill).toBe(false);
    const buffered = weatherRow(weatherMsg('lwm-2', { temperature_k: 279, backfill: true }, T - 60_000))!;
    expect(buffered.backfill).toBe(true);
    expect(buffered.ts).toBe(T - 60_000);
  });

  it('reads the sonic, soiling and pan instruments', () => {
    expect(sonicRow(tel('arl/lwm/lwm-3/telemetry/sonic', { v: 1, ts: T, entity: 'lwm-3', sonic_temperature_k: 284.4, wind_u_ms: 3.6 }))).toMatchObject({
      sonicTemperatureK: 284.4,
      windUMs: 3.6,
    });
    expect(soilingRow(tel('arl/lwm/lwm-4/telemetry/soiling', { v: 1, ts: T, entity: 'lwm-4', soiling_ratio: 0.97 }))).toMatchObject({ soilingRatio: 0.97 });
    expect(panRow(tel('arl/lwm/lwm-5/telemetry/pan', { v: 1, ts: T, entity: 'lwm-5', pan_level_mm: 196 }))).toMatchObject({ panLevelMm: 196 });
  });

  it('parses a strike event into the row the lightning map is drawn from', () => {
    expect(lightningRow(strikeMsg({ distance_km: 12.5, bearing_rad: 1.2, detected_by: ['lwm-1', 'lwm-2'] }))).toEqual({
      ts: T,
      distanceKm: 12.5,
      bearingRad: 1.2,
      detectedBy: ['lwm-1', 'lwm-2'],
    });
  });
});

// ----------------------------------------------------------------- reducer
describe('lwm state', () => {
  it('folds a live weather sample into the site latest and history', () => {
    const s = emptyLwmState();
    expect(reduceLwm(s, weatherMsg('lwm-1', { temperature_k: 285, wind_gust_ms: 8 }))).toBe(true);
    expect(s.sites['lwm-1']!.latest?.temperatureK).toBe(285);
    expect(s.sites['lwm-1']!.history).toHaveLength(1);
    expect(s.sites['lwm-1']!.backfilling).toBe(false);
  });

  it('records a buffered backfill sample without moving the live reading', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-1', { temperature_k: 285 }, T));
    expect(reduceLwm(s, weatherMsg('lwm-1', { temperature_k: 270, backfill: true }, T - 60_000))).toBe(false);
    expect(s.sites['lwm-1']!.backfilling).toBe(true);
    expect(s.sites['lwm-1']!.latest?.temperatureK).toBe(285); // the live latest is untouched
    expect(s.sites['lwm-1']!.history).toHaveLength(1);
  });

  it('clears the backfilling flag when a live sample arrives again', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-1', { temperature_k: 270, backfill: true }, T - 60_000));
    expect(s.sites['lwm-1']!.backfilling).toBe(true);
    reduceLwm(s, weatherMsg('lwm-1', { temperature_k: 285 }, T));
    expect(s.sites['lwm-1']!.backfilling).toBe(false);
  });

  it('keeps the newest live sample as latest regardless of arrival order', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-2', { temperature_k: 290 }, T + 60_000));
    reduceLwm(s, weatherMsg('lwm-2', { temperature_k: 280 }, T)); // older, arrives later
    expect(s.sites['lwm-2']!.latest?.temperatureK).toBe(290);
    expect(s.sites['lwm-2']!.history).toHaveLength(2);
  });

  it('folds the extra instruments onto their own sites', () => {
    const s = emptyLwmState();
    reduceLwm(s, tel('arl/lwm/lwm-3/telemetry/sonic', { v: 1, ts: T, entity: 'lwm-3', sonic_temperature_k: 284.4 }));
    reduceLwm(s, tel('arl/lwm/lwm-4/telemetry/soiling', { v: 1, ts: T, entity: 'lwm-4', soiling_ratio: 0.97 }));
    reduceLwm(s, tel('arl/lwm/lwm-5/telemetry/pan', { v: 1, ts: T, entity: 'lwm-5', pan_level_mm: 196 }));
    expect(s.sites['lwm-3']!.sonic?.sonicTemperatureK).toBe(284.4);
    expect(s.sites['lwm-4']!.soiling?.soilingRatio).toBe(0.97);
    expect(s.sites['lwm-5']!.pan?.panLevelMm).toBe(196);
  });

  it('drops a buffered backfill on an instrument stream too', () => {
    const s = emptyLwmState();
    expect(reduceLwm(s, tel('arl/lwm/lwm-3/telemetry/sonic', { v: 1, ts: T, entity: 'lwm-3', sonic_temperature_k: 284.4, backfill: true }))).toBe(false);
    expect(s.sites['lwm-3']!.sonic).toBeNull();
  });

  it('folds the global lightning summary', () => {
    const s = emptyLwmState();
    reduceLwm(s, tel('arl/lwm/global/telemetry/lightning', { v: 1, ts: T, entity: 'global', nearest_strike_km: 8, strikes_last_min: 2 }));
    expect(s.global.nearestStrikeKm).toBe(8);
    expect(s.global.strikesLastMin).toBe(2);
    expect(s.global.lightningTs).toBe(T);
  });

  it('pushes each strike event and remembers who saw it', () => {
    const s = emptyLwmState();
    reduceLwm(s, strikeMsg({ distance_km: 20, bearing_rad: 1, detected_by: ['lwm-1'] }, T));
    reduceLwm(s, strikeMsg({ distance_km: 18, bearing_rad: 1.1, detected_by: ['lwm-1', 'lwm-2'] }, T + 1000));
    expect(s.strikes).toHaveLength(2);
    expect(s.strikes[1]).toEqual({ ts: T + 1000, distanceKm: 18, bearingRad: 1.1, detectedBy: ['lwm-1', 'lwm-2'] });
  });

  it('folds retained site and network state', () => {
    const s = emptyLwmState();
    reduceLwm(s, msg('arl/lwm/lwm-1/state/enabled', { v: 1, ts: T, entity: 'lwm-1', item: 'enabled', value: true }));
    reduceLwm(s, msg('arl/lwm/lwm-1/state/sample_interval_s', { v: 1, ts: T, entity: 'lwm-1', item: 'sample_interval_s', value: 60 }));
    reduceLwm(s, msg('arl/lwm/lwm-1/state/position', { v: 1, ts: T, entity: 'lwm-1', item: 'position', value: { lat: -31.2, lon: 21.67 } }));
    reduceLwm(s, msg('arl/lwm/global/state/active_sites', { v: 1, ts: T, entity: 'global', item: 'active_sites', value: 5 }));
    reduceLwm(s, msg('arl/lwm/global/state/active_alerts', { v: 1, ts: T, entity: 'global', item: 'active_alerts', value: ['lwm-high_wind-lwm-1-0001'] }));
    expect(s.sites['lwm-1']!.enabled).toBe(true);
    expect(s.sites['lwm-1']!.sampleIntervalS).toBe(60);
    expect(s.sites['lwm-1']!.position).toEqual({ lat: -31.2, lon: 21.67 });
    expect(s.global.activeSites).toBe(5);
    expect(s.global.activeAlerts).toEqual(['lwm-high_wind-lwm-1-0001']);
  });

  it('trims live weather history to the four-hour window', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-1', { temperature_k: 280 }, T - 5 * HOUR)); // older than the window
    reduceLwm(s, weatherMsg('lwm-1', { temperature_k: 285 }, T));
    expect(s.sites['lwm-1']!.history.map((h) => h.ts)).toEqual([T]);
  });
});

// ------------------------------------------------------------------ derive
describe('lwm derive', () => {
  it('gives a dew point equal to the temperature at saturation and below it otherwise', () => {
    expect(dewPointK(284.84, 100)).toBeCloseTo(284.84, 6);
    const dp = dewPointK(284.84, 34.2)!;
    expect(dp).toBeLessThan(284.84);
    expect(dp).toBeCloseTo(269.6, 0);
    expect(dewPointK(null, 50)).toBeNull();
    expect(dewPointK(285, null)).toBeNull();
    expect(dewPointK(285, 0)).toBeNull(); // ln undefined at 0 % humidity
    expect(dewPointK(285, 101)).toBeNull(); // out of range
  });

  it('sums the rainfall over the last hour only', () => {
    const h = [w(T - 2 * HOUR, { rainfallMm: 100 }), w(T - 30 * MIN, { rainfallMm: 1 }), w(T - 10 * MIN, { rainfallMm: 2 }), w(T, { rainfallMm: 0.5 })];
    expect(rainRateMmH(h)).toBeCloseTo(3.5, 6); // the 2 h-old downpour is outside the window
    expect(rainRateMmH([])).toBeNull();
    expect(rainRateMmH([w(T, {})])).toBeNull(); // no rainfall reading in the window
  });

  it('reads the 3 h pressure tendency and gives up without a baseline', () => {
    expect(pressureTendencyHpa3h([w(T - 3 * HOUR, { pressureHpa: 870 }), w(T, { pressureHpa: 875 })])).toBeCloseTo(5, 6);
    expect(pressureTendencyHpa3h([w(T - HOUR, { pressureHpa: 870 }), w(T, { pressureHpa: 875 })])).toBeNull(); // too far from the 3 h mark
    expect(pressureTendencyHpa3h([w(T, {})])).toBeNull(); // the latest has no pressure
  });

  it('bins the wind into a 16-point rose weighted by speed', () => {
    const rose = windRose([
      w(T, { windDirectionRad: 0, windSpeedMs: 5 }), // N
      w(T, { windDirectionRad: Math.PI, windSpeedMs: 3 }), // S
      w(T, { windDirectionRad: Math.PI, windSpeedMs: 7 }), // S again
      w(T, { windDirectionRad: null, windSpeedMs: 9 }), // skipped: no direction
    ]);
    expect(rose).toHaveLength(16);
    expect(rose[0]!.label).toBe('N');
    expect(rose[0]!.count).toBe(1);
    expect(rose[8]!.label).toBe('S');
    expect(rose[8]!.count).toBe(2);
    expect(rose[8]!.sumSpeedMs).toBe(10);
    expect(rose[8]!.meanSpeedMs).toBe(5);
    expect(rose[4]!.count).toBe(0);
    expect(rose[4]!.meanSpeedMs).toBeNull();
  });

  it('converts a meteorological bearing to degrees clockwise from north', () => {
    expect(bearingToDeg(0)).toBeCloseTo(0, 9);
    expect(bearingToDeg(Math.PI / 2)).toBeCloseTo(90, 9);
    expect(bearingToDeg(Math.PI)).toBeCloseTo(180, 9);
    expect(bearingToDeg(-Math.PI / 2)).toBeCloseTo(270, 9);
    expect(bearingToDeg(2 * Math.PI)).toBeCloseTo(0, 9);
  });

  it('forecasts the battery drain and the hours to the alert limit', () => {
    const discharging = batteryForecast([w(T, { batteryV: 12 }), w(T + HOUR, { batteryV: 11 })], 10);
    expect(discharging.batteryV).toBe(11);
    expect(discharging.drainVph).toBeCloseTo(-1, 6);
    expect(discharging.hoursToMin).toBeCloseTo(1, 6);

    const charging = batteryForecast([w(T, { batteryV: 11 }), w(T + HOUR, { batteryV: 12 })], 10);
    expect(charging.drainVph).toBeCloseTo(1, 6);
    expect(charging.hoursToMin).toBeNull(); // not draining, so no time to the limit

    expect(batteryForecast([w(T, { batteryV: 12 })], 10).drainVph).toBeNull(); // one point, no slope
  });

  it('summarises an approaching storm from the strike events', () => {
    const s = emptyLwmState();
    reduceLwm(s, strikeMsg({ distance_km: 30, bearing_rad: 0 }, T));
    reduceLwm(s, strikeMsg({ distance_km: 25, bearing_rad: 0.5 }, T + 5 * MIN));
    reduceLwm(s, strikeMsg({ distance_km: 20, bearing_rad: 1 }, T + 10 * MIN));
    const sum = lightningSummary(s, DEFAULT_LWM_LIMITS);
    expect(sum.strikesLast10Min).toBe(2); // the two inside the 10 min count window
    expect(sum.nearestKm).toBe(20);
    expect(sum.bearingRad).toBe(1);
    expect(sum.approachKmh).toBeCloseTo(60, 6); // 5 km every 5 min
    expect(sum.withinMaxKm).toBe(false); // 20 km is outside the 10 km limit
  });

  it('flags lightning inside the max range', () => {
    const s = emptyLwmState();
    reduceLwm(s, strikeMsg({ distance_km: 6, bearing_rad: 2 }, T));
    const sum = lightningSummary(s, DEFAULT_LWM_LIMITS);
    expect(sum.withinMaxKm).toBe(true);
    expect(sum.nearestKm).toBe(6);
  });

  it('falls back to the published summary when there are no strike events', () => {
    const s = emptyLwmState();
    reduceLwm(s, tel('arl/lwm/global/telemetry/lightning', { v: 1, ts: T, entity: 'global', nearest_strike_km: 8, strikes_last_min: 1 }));
    const sum = lightningSummary(s, DEFAULT_LWM_LIMITS);
    expect(sum.nearestKm).toBe(8);
    expect(sum.withinMaxKm).toBe(true);
    expect(sum.approachKmh).toBeNull();
  });

  it('measures the sonic thermometer against the main one on lwm-3 only', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-3', { temperature_k: 284.0 }, T));
    reduceLwm(s, tel('arl/lwm/lwm-3/telemetry/sonic', { v: 1, ts: T, entity: 'lwm-3', sonic_temperature_k: 284.4 }));
    expect(sonicDeltaK(s.sites['lwm-3']!)).toBeCloseTo(0.4, 6);
    const d = deriveLwm(s);
    expect(d.sites['lwm-3']!.sonicDeltaK).toBeCloseTo(0.4, 6);
    expect(d.sites['lwm-1']!.sonicDeltaK).toBeNull(); // no sonic anemometer there
  });

  it('derives the whole network from the folded state', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-1', { temperature_k: 284.84, humidity_pct: 34.2, wind_gust_ms: 7 }, T));
    const d = deriveLwm(s);
    expect(d.sites['lwm-1']!.dewPointK).toBeCloseTo(269.6, 0);
    expect(d.sites['lwm-1']!.battery.batteryV).toBeNull(); // the sample carried no battery_v
    expect(d.lightning.withinMaxKm).toBe(false);
  });

  it('maps the published alert limits, tolerating a prefix and falling back to the default', () => {
    expect(lwmLimitsFrom(null)).toEqual(DEFAULT_LWM_LIMITS);
    const bare = lwmLimitsFrom([{ key: 'high_wind.warn_ms', value: 18 }]);
    expect(bare.highWindWarnMs).toBe(18);
    expect(bare.lightningMaxKm).toBe(DEFAULT_LWM_LIMITS.lightningMaxKm);
    const prefixed = lwmLimitsFrom([{ key: 'lwm.battery.min_v', value: 11.0 }]);
    expect(prefixed.batteryMinV).toBe(11.0);
  });
});

// ----------------------------------------------------------- interpolation
describe('lwm interpolation', () => {
  const bounds: GridBounds = { minLon: 0, maxLon: 1, minLat: 0, maxLat: 1 };

  it('gives a flat field with a single contributor (the honest answer with one reading)', () => {
    const grid = idwGrid([{ id: 'a', lat: 0.5, lon: 0.5, value: 10 }], bounds, 3, 3);
    expect(grid.values.every((v) => v === 10)).toBe(true);
    expect(grid.min).toBe(10);
    expect(grid.max).toBe(10);
  });

  it('snaps a grid point that lands on a site to that site reading', () => {
    const grid = idwGrid(
      [
        { id: 'a', lat: 1, lon: 0, value: 99 }, // north-west corner (row 0, col 0)
        { id: 'b', lat: 0, lon: 1, value: 1 }, // south-east corner (row 2, col 2)
      ],
      bounds,
      3,
      3,
    );
    expect(grid.values[0]).toBe(99);
    expect(grid.values[8]).toBe(1);
    expect(grid.min).toBe(1);
    expect(grid.max).toBe(99);
  });

  it('interpolates between two readings and snaps at the sites', () => {
    const grid = idwGrid(
      [
        { id: 'a', lat: 0, lon: 0, value: 0 },
        { id: 'b', lat: 0, lon: 1, value: 10 },
      ],
      bounds,
      3,
      3,
    );
    expect(grid.values[6]).toBe(0); // south-west corner snaps to a
    expect(grid.values[7]).toBeCloseTo(5, 6); // equidistant midpoint
    expect(grid.values[8]).toBe(10); // south-east corner snaps to b
  });

  it('ignores a site with no reading and is empty when nothing can contribute', () => {
    const partial = idwGrid(
      [
        { id: 'a', lat: 0.5, lon: 0.5, value: 10 },
        { id: 'b', lat: 0.9, lon: 0.9, value: null },
      ],
      bounds,
      2,
      2,
    );
    expect(partial.values.every((v) => v === 10)).toBe(true);

    const empty = idwGrid([{ id: 'a', lat: 0.5, lon: 0.5, value: null }], bounds, 3, 3);
    expect(empty.values.every((v) => v === null)).toBe(true);
    expect(empty.min).toBeNull();
    expect(empty.max).toBeNull();
  });

  it('takes the map bounds from a geojson outline', () => {
    const gj = {
      type: 'FeatureCollection',
      features: [{ geometry: { type: 'Polygon', coordinates: [[[21.6, -31.2], [21.7, -31.1], [21.65, -31.15], [21.6, -31.2]]] } }],
    };
    expect(boundsFromGeoJson(gj)).toEqual({ minLon: 21.6, maxLon: 21.7, minLat: -31.2, maxLat: -31.1 });
    expect(boundsFromGeoJson({ type: 'Point', coordinates: [10, 20] })).toEqual({ minLon: 10, maxLon: 10, minLat: 20, maxLat: 20 });
    expect(boundsFromGeoJson({})).toBeNull();
  });

  it('falls back to the site extent with a margin', () => {
    expect(boundsFromSites([{ id: 'a', lat: 0, lon: 0, value: 1 }, { id: 'b', lat: 1, lon: 2, value: 2 }], 0.5)).toEqual({
      minLon: -0.5,
      maxLon: 2.5,
      minLat: -0.5,
      maxLat: 1.5,
    });
    expect(boundsFromSites([{ id: 'a', lat: Number.NaN, lon: 0, value: 1 }])).toBeNull();
    expect(boundsFromSites([])).toBeNull();
  });

  it('builds the per-site samples for one variable, NaN where the position is unknown', () => {
    const samples = siteSamples([whr('lwm-1', { temperatureK: 285 }), whr('lwm-2', { temperatureK: 290 })], (r) => r.temperatureK, {
      'lwm-1': { lat: -31.2, lon: 21.67 },
    });
    expect(samples[0]).toEqual({ id: 'lwm-1', lat: -31.2, lon: 21.67, value: 285 });
    expect(samples[1]!.id).toBe('lwm-2');
    expect(samples[1]!.value).toBe(290);
    expect(Number.isNaN(samples[1]!.lat)).toBe(true);
  });
});

// ----------------------------------------------------------------- history
describe('lwm history integration', () => {
  it('stores a buffered sample with its original ts and flag', () => {
    const db = memDb();
    upsertWeather(db, weatherRow(weatherMsg('lwm-1', { temperature_k: 285 }))!);
    upsertWeather(db, weatherRow(weatherMsg('lwm-1', { temperature_k: 270, backfill: true }, T - 60_000))!);
    expect(loadWeatherFor(db, 'lwm-1', T - HOUR, T).map((r) => [r.ts, r.backfill])).toEqual([
      [T - 60_000, true],
      [T, false],
    ]);
  });

  it('reads the latest sample per site at a time, backfill included, so the map can scrub', () => {
    const db = memDb();
    upsertWeather(db, weatherRow(weatherMsg('lwm-1', { temperature_k: 285 }))!);
    upsertWeather(db, weatherRow(weatherMsg('lwm-1', { temperature_k: 270, backfill: true }, T - 60_000))!);
    upsertWeather(db, weatherRow(weatherMsg('lwm-2', { temperature_k: 290 }))!);
    // at T the latest per site is the live sample
    expect(weatherAt(db, T).map((r) => [r.entity, r.temperatureK])).toEqual([
      ['lwm-1', 285],
      ['lwm-2', 290],
    ]);
    // rewound before the live sample, the buffered one is the latest for lwm-1 (backfill included)
    expect(weatherAt(db, T - 30_000).map((r) => [r.entity, r.temperatureK, r.backfill])).toEqual([['lwm-1', 270, true]]);
  });

  it('persists a strike event for the lightning map', () => {
    const db = memDb();
    insertLightning(db, lightningRow(strikeMsg({ distance_km: 12, bearing_rad: 1, detected_by: ['lwm-1'] }))!);
    expect(loadLightning(db, T - 1000, T + 1000)).toEqual([{ ts: T, distanceKm: 12, bearingRad: 1, detectedBy: ['lwm-1'] }]);
  });
});

// -------------------------------------------------------------- safeguards
describe('lwm safeguards', () => {
  const view = (s: LwmState, limits: LwmLimits = DEFAULT_LWM_LIMITS): LwmControlView => ({
    state: s,
    derived: () => deriveLwm(s, limits),
    limits: () => limits,
  });
  const spec = (s: LwmState, control: string, limits?: LwmLimits): CommandSpec => lwmCommandSpecs(view(s, limits)).find((c) => c.control === control)!;
  const guardInput = (entity: string, value: unknown) => ({ service: 'lwm' as const, entity, value, ctx: {} as never });

  it('refuses a technician visit while a strike is inside the max range', () => {
    const s = emptyLwmState();
    reduceLwm(s, strikeMsg({ distance_km: 6, bearing_rad: 1 }, T));
    expect(spec(s, 'service_anemometer').guard!(guardInput('lwm-1', true))?.code).toBe('lightning_proximity');
    expect(spec(s, 'clean_reference_cell').guard!(guardInput('lwm-4', true))?.code).toBe('lightning_proximity');
    expect(spec(s, 'refill_pan').guard!(guardInput('lwm-5', true))?.code).toBe('lightning_proximity');
  });

  it('refuses a technician visit while the Lightning Proximity alert is raised', () => {
    const s = emptyLwmState();
    reduceLwm(s, msg('arl/lwm/global/state/active_alerts', { v: 1, ts: T, entity: 'global', item: 'active_alerts', value: ['lwm-lightning_proximity-global-0001'] }));
    expect(spec(s, 'service_anemometer').guard!(guardInput('lwm-1', true))?.code).toBe('lightning_proximity');
  });

  it('allows a technician visit in clear weather', () => {
    expect(spec(emptyLwmState(), 'service_anemometer').guard!(guardInput('lwm-1', true))).toBeNull();
  });

  it('refuses a recalibration in high wind', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-1', { wind_gust_ms: 18 }, T)); // above the 15 m/s warning limit
    const blocked = spec(s, 'request_recalibration').guard!(guardInput('lwm-1', true));
    expect(blocked?.code).toBe('sensor_disturbed');
    expect(blocked?.message).toContain('18.0 m/s');
  });

  it('refuses a recalibration while the site replays buffered samples', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-2', { wind_gust_ms: 4, backfill: true }, T - 60_000));
    expect(spec(s, 'request_recalibration').guard!(guardInput('lwm-2', true))?.code).toBe('backfill_in_progress');
  });

  it('refuses a recalibration of a site the network does not have', () => {
    expect(spec(emptyLwmState(), 'request_recalibration').guard!(guardInput('lwm-9', true))?.code).toBe('unknown_target');
  });

  it('allows a recalibration in calm, caught-up conditions', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-1', { wind_gust_ms: 8 }, T));
    expect(spec(s, 'request_recalibration').guard!(guardInput('lwm-1', true))).toBeNull();
  });

  it('refuses a pan refill once the pan is already full enough', () => {
    const s = emptyLwmState();
    reduceLwm(s, tel('arl/lwm/lwm-5/telemetry/pan', { v: 1, ts: T, entity: 'lwm-5', pan_level_mm: 196 }));
    const blocked = spec(s, 'refill_pan').guard!(guardInput('lwm-5', true));
    expect(blocked?.code).toBe('not_needed');
    expect(blocked?.message).toContain(`${REFILL_NOT_NEEDED_MM} mm`);
  });

  it('allows a pan refill when the pan is low', () => {
    const s = emptyLwmState();
    reduceLwm(s, tel('arl/lwm/lwm-5/telemetry/pan', { v: 1, ts: T, entity: 'lwm-5', pan_level_mm: 180 }));
    expect(spec(s, 'refill_pan').guard!(guardInput('lwm-5', true))).toBeNull();
  });

  it('confirms a short sample interval on a low battery', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-1', { battery_v: 11.8 }, T)); // at/below min_v + 0.5 V
    const si = spec(s, 'sample_interval');
    expect(si.confirm!(guardInput('lwm-1', 10))).not.toBeNull();
    expect(si.confirm!(guardInput('lwm-1', 60))).toBeNull(); // not a short interval
  });

  it('confirms a short interval when the pack will run down soon', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-1', { battery_v: 13.3 }, T));
    reduceLwm(s, weatherMsg('lwm-1', { battery_v: 12.4 }, T + HOUR)); // draining ~0.9 V/h: under 6 h to the limit
    const need = spec(s, 'sample_interval').confirm!(guardInput('lwm-1', 10))!;
    expect(need).not.toBeNull();
    expect(need.title).toContain('lwm-1');
  });

  it('does not confirm a short interval on a healthy battery', () => {
    const s = emptyLwmState();
    reduceLwm(s, weatherMsg('lwm-1', { battery_v: 13.0 }, T));
    expect(spec(s, 'sample_interval').confirm!(guardInput('lwm-1', 10))).toBeNull();
  });

  it('validates the sample interval bounds', () => {
    const si = spec(emptyLwmState(), 'sample_interval');
    expect(si.schema.safeParse(5).success).toBe(false); // below the 10 s minimum
    expect(si.schema.safeParse(15).success).toBe(false); // not a multiple of 10 s
    expect(si.schema.safeParse(3601).success).toBe(false); // above the 3600 s maximum
    expect(si.schema.safeParse(20.5).success).toBe(false); // whole seconds only
    expect(si.schema.safeParse(10).success).toBe(true);
    expect(si.schema.safeParse(3600).success).toBe(true);
  });

  it('accepts only a boolean for the site enable control', () => {
    const en = spec(emptyLwmState(), 'enable_site');
    expect(en.schema.safeParse(true).success).toBe(true);
    expect(en.schema.safeParse('yes').success).toBe(false);
  });
});

// ----------------------------------------------------------------- presets
describe('lwm presets', () => {
  it('ships storm watch, battery saver and normal, each setting the interval on all five sites', () => {
    const presets = lwmPresets();
    expect(presets.map((p) => p.id)).toEqual(['lwm-storm-watch', 'lwm-battery-saver', 'lwm-normal']);
    for (const p of presets) {
      expect(p.steps).toHaveLength(SITE_IDS.length);
      expect(p.steps.map((s) => s.entity)).toEqual([...SITE_IDS]);
      expect(p.steps.every((s) => s.control === 'sample_interval')).toBe(true);
    }
    expect(presets[0]!.steps.every((s) => s.value === 10)).toBe(true); // storm watch
    expect(presets[1]!.steps.every((s) => s.value === 600)).toBe(true); // battery saver
    expect(presets[2]!.steps.every((s) => s.value === 60)).toBe(true); // normal
  });
});
