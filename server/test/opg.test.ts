// P6: OPG parsing (four power entities + refuel), the derived plant numbers and the safeguards.
import { describe, expect, it } from 'vitest';
import { bucketEnergy, energyOf, type PowerHistoryRow } from '../src/db/opg.js';
import {
  DEFAULT_RESERVE_PCT,
  opgCommandSpecs,
  opgPresets,
  type OpgControlView,
} from '../src/plugins/opg/controls.js';
import { deriveOpg, irradianceAgreement, pearson, PLANT } from '../src/plugins/opg/derive.js';
import { emptyOpgState, reduceOpg, type OpgState } from '../src/plugins/opg/model.js';
import { isPowerSample, parseOpg, powerColumns } from '../src/plugins/opg/parse.js';
import type { CommandSpec } from '../src/commands/types.js';
import type { ParsedTelemetry } from '../src/core/parse.js';
import { fixture } from './helpers.js';

const T = 1_793_602_860_000;

const msg = (topic: string, payload: unknown) =>
  parseOpg(topic, Buffer.from(JSON.stringify(payload)), T, false)[0]!;

/** The four power samples of one simulated minute, as the plant actually publishes them. */
function powerSamples(over: Record<string, Record<string, unknown>> = {}) {
  const base = {
    global: { total_generation_w: 681_179, total_load_w: 186_447, supply_mode: 'solar' },
    solar: { power_output_w: 681_179, irradiance_wm2: 616, panel_temperature_k: 303.34, inverter_status: 'online' },
    batteries: { state_of_charge_pct: 71.2, battery_power_w: 494_732, battery_temperature_k: 285.51, battery_health_pct: 94.5 },
    diesel: { fuel_level_pct: 80, power_output_w: 0, generator_status: 'off', runtime_h: 4424.74 },
  };
  const state = emptyOpgState();
  for (const [entity, fields] of Object.entries(base)) {
    reduceOpg(
      state,
      msg(`arl/opg/${entity}/telemetry/power`, { v: 1, ts: T, seq: 5, entity, ...fields, ...(over[entity] ?? {}) }),
    );
  }
  // the plant's retained configuration, published once at start-up
  const config = [
    ['global', 'generation_priority', 'solar_first'],
    ['global', 'load_shed', false],
    ['solar', 'enabled', true],
    ['batteries', 'reserve_pct', 20],
  ] as const;
  for (const [entity, item, value] of config) {
    reduceOpg(state, msg(`arl/opg/${entity}/state/${item}`, { v: 1, ts: T, entity, item, value }));
  }
  return state;
}

const view = (s: OpgState): OpgControlView => ({ state: s, derived: () => deriveOpg(s) });

function spec(state: OpgState, control: string): CommandSpec {
  return opgCommandSpecs(view(state)).find((c) => c.control === control)!;
}

const guardInput = (entity: string, value: unknown) => ({ service: 'opg' as const, entity, value, ctx: {} as never });
const confirmInput = guardInput;

// ------------------------------------------------------------------ parser
describe('opg parse', () => {
  it('drops other services (the platform routes by service, this is the second guard)', () => {
    expect(parseOpg('arl/lwm/site-a/telemetry/weather', Buffer.from('{}'), T, false)).toEqual([]);
  });

  it('accepts every power entity from the recorded fixture', () => {
    const powers = fixture('lwm-opg.txt')
      .flatMap((l) => parseOpg(l.topic, Buffer.from(l.payload), T, false))
      .filter(isPowerSample);
    expect(powers.length).toBeGreaterThan(4);
    expect(powers.slice(0, 4).map((p) => p.entity)).toEqual(['global', 'solar', 'batteries', 'diesel']);
  });

  it('gives each entity only the columns it owns, so the minute row merges by upsert', () => {
    const columns = Object.entries({
      global: { total_generation_w: 1, total_load_w: 2 },
      solar: { power_output_w: 3, irradiance_wm2: 4 },
      batteries: { state_of_charge_pct: 5, battery_power_w: 6 },
      diesel: { power_output_w: 7, fuel_level_pct: 8 },
    }).map(([entity, fields]) => {
      const p = msg(`arl/opg/${entity}/telemetry/power`, { v: 1, ts: T, entity, ...fields });
      return isPowerSample(p) ? powerColumns(p) : null;
    });
    expect(columns).toEqual([
      { ts: T, loadW: 2, generationW: 1 },
      { ts: T, solarW: 3, irradianceWm2: 4 },
      { ts: T, batteryW: 6, socPct: 5 },
      { ts: T, dieselW: 7, fuelPct: 8 },
    ]);
  });

  it('treats a missing measurement as null instead of rejecting the sample', () => {
    const p = msg('arl/opg/solar/telemetry/power', { v: 1, ts: T, entity: 'solar', power_output_w: 10 });
    expect(isPowerSample(p)).toBe(true);
    expect(powerColumns(p as ParsedTelemetry)).toEqual({ ts: T, solarW: 10, irradianceWm2: null });
  });

  it('rejects a sample whose documented field has the wrong type', () => {
    const p = msg('arl/opg/solar/telemetry/power', {
      v: 1,
      ts: T,
      entity: 'solar',
      power_output_w: 'lots',
      irradiance_wm2: 616,
    });
    expect(isPowerSample(p)).toBe(false);
  });
});

// ----------------------------------------------------------------- reducer
describe('opg state', () => {
  it('folds the four samples and the state items into one plant', () => {
    const s = powerSamples();
    for (const [entity, item, value] of [
      ['global', 'generation_priority', 'solar_first'],
      ['global', 'load_shed', false],
      ['solar', 'enabled', true],
      ['batteries', 'reserve_pct', 20],
    ] as const) {
      reduceOpg(s, msg(`arl/opg/${entity}/state/${item}`, { v: 1, ts: T, entity, item, value }));
    }
    expect(s.global.totalLoadW).toBe(186_447);
    expect(s.solar.irradianceWm2).toBe(616);
    expect(s.batteries.socPct).toBeCloseTo(71.2, 6);
    expect(s.diesel.fuelPct).toBe(80);
    expect(s.global.generationPriority).toBe('solar_first');
    expect(s.global.loadShed).toBe(false);
    expect(s.solar.enabled).toBe(true);
    expect(s.batteries.reservePct).toBe(20);
  });

  it('records a refuel event and takes the fuel level from it', () => {
    const s = powerSamples();
    reduceOpg(s, msg('arl/opg/events/refuel', { v: 1, ts: T + 60_000, entity: 'diesel', litres: 4000, fuel_level_pct: 100 }));
    expect(s.refuels).toEqual([{ ts: T + 60_000, litres: 4000, fuelPct: 100 }]);
    expect(s.diesel.fuelPct).toBe(100);
  });

  it('clears a removed state item', () => {
    const s = powerSamples();
    reduceOpg(s, msg('arl/opg/solar/state/enabled', { v: 1, ts: T, entity: 'solar', item: 'enabled', value: true }));
    reduceOpg(s, msg('arl/opg/solar/state/enabled', { v: 1, ts: T, entity: 'solar', item: 'enabled', removed: true }));
    expect(s.solar.enabled).toBeNull();
  });
});

// ------------------------------------------------------------------ derive
describe('opg derive', () => {
  it('computes the net balance and the renewable share from the samples', () => {
    const d = deriveOpg(powerSamples());
    expect(d.netW).toBe(681_179 - 186_447);
    // solar covers the whole load; the surplus is curtailed, so the share is capped at 100 %
    expect(d.renewableFraction).toBe(1);
  });

  it('expects solar output from irradiance and caps it at the inverter rating', () => {
    const d = deriveOpg(powerSamples());
    expect(d.solarExpectedW).toBeCloseTo((616 / 1000) * PLANT.solarKwp * 1000, 6);
    expect(d.solarPerformanceRatio).toBeCloseTo(681_179 / d.solarExpectedW!, 4);
    expect(d.solarHeadroomW).toBe(PLANT.inverterKw * 1000 - 681_179);

    const noon = deriveOpg(powerSamples({ solar: { irradiance_wm2: 1300 } }));
    expect(noon.solarExpectedW).toBe(PLANT.inverterKw * 1000);
  });

  it('gives no performance ratio in the dark', () => {
    const d = deriveOpg(powerSamples({ solar: { irradiance_wm2: 3 } }));
    expect(d.solarExpectedW).toBeNull();
    expect(d.solarPerformanceRatio).toBeNull();
  });

  it('turns state of charge into stored and usable energy', () => {
    const d = deriveOpg(powerSamples());
    expect(d.storedKwh).toBeCloseTo(2848, 6);
    expect(d.usableKwh).toBeCloseTo(2048, 6);
    // charging, so there is no time to the reserve
    expect(d.timeToReserveH).toBeNull();
  });

  it('gives hours to the reserve while the bank is discharging', () => {
    const s = powerSamples({ batteries: { state_of_charge_pct: 60, battery_power_w: -200_000 } });
    const d = deriveOpg(s);
    expect(d.usableKwh).toBeCloseTo(1600, 6);
    expect(d.timeToReserveH).toBeCloseTo(8, 6);
    // one hour of discharge is capped by the bank's inverter rating
    expect(d.availableBatteryW).toBe(PLANT.batteryMaxKw * 1000);
  });

  it('counts diesel hours left only while the generators are burning fuel', () => {
    expect(deriveOpg(powerSamples()).dieselHoursLeftH).toBeNull();

    const running = deriveOpg(powerSamples({ diesel: { power_output_w: 150_000, generator_status: 'running' } }));
    const burn = 150 * PLANT.dieselLPerKwh;
    expect(running.burnLph).toBeCloseTo(burn, 6);
    expect(running.fuelLitres).toBe(16_000);
    expect(running.dieselHoursLeftH).toBeCloseTo(16_000 / burn, 6);

    const idle = deriveOpg(powerSamples({ diesel: { power_output_w: 0, generator_status: 'running' } }));
    expect(idle.burnLph).toBe(PLANT.dieselIdleLph);
  });

  it('flags a shortfall only when solar, diesel and the bank cannot cover the load', () => {
    const covered = powerSamples({
      global: { total_generation_w: 100_000, total_load_w: 500_000 },
      solar: { power_output_w: 90_000 },
      diesel: { power_output_w: 0, generator_status: 'off' },
      batteries: { state_of_charge_pct: 22, battery_power_w: -100_000 },
    });
    // the bank can still give 80 kW for an hour: 410 kW of load is left
    expect(deriveOpg(covered).shortfall).toBe(true);

    const atReserve = powerSamples({
      global: { total_generation_w: 100_000, total_load_w: 200_000 },
      solar: { power_output_w: 90_000 },
      batteries: { state_of_charge_pct: 20, battery_power_w: 0 },
    });
    const d = deriveOpg(atReserve);
    expect(d.availableBatteryW).toBe(0);
    expect(d.uncoveredW).toBe(110_000);
    expect(d.shortfall).toBe(true);
  });

  it('correlates the plant irradiance with the weather stations', () => {
    expect(pearson([1, 2], [1, 2])).toBeNull();
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 9);

    const opg = [
      { ts: 60_000, wm2: 500 },
      { ts: 120_000, wm2: 600 },
      { ts: 180_000, wm2: 700 },
      { ts: 240_000, wm2: null },
    ];
    const lwm = [
      { ts: 60_000, wm2: 480 },
      { ts: 120_000, wm2: 560 },
      { ts: 180_000, wm2: 640 },
      { ts: 300_000, wm2: 800 },
    ];
    const a = irradianceAgreement(opg, lwm);
    expect(a.n).toBe(3);
    expect(a.r).toBeCloseTo(1, 9);
    expect(a.biasWm2).toBeCloseTo(40, 6);
    expect(a.opgMeanWm2).toBeCloseTo(600, 6);
    expect(a.lwmMeanWm2).toBeCloseTo(560, 6);
  });
});

// ----------------------------------------------------------------- history
describe('opg energy integration', () => {
  const row = (ts: number, over: Partial<PowerHistoryRow> = {}): PowerHistoryRow => ({
    ts,
    solarW: null,
    batteryW: null,
    dieselW: null,
    loadW: null,
    generationW: null,
    socPct: null,
    fuelPct: null,
    irradianceWm2: null,
    ...over,
  });

  it('integrates each source over the minute each sample stands for', () => {
    const rows = [
      row(T, { solarW: 600_000, loadW: 200_000, batteryW: 400_000 }),
      row(T + 60_000, { solarW: 300_000, loadW: 200_000, batteryW: 100_000 }),
    ];
    const e = energyOf(rows);
    // 600 kW for one minute, then 300 kW for one minute
    expect(e.solarKwh).toBeCloseTo(10 + 5, 6);
    expect(e.loadKwh).toBeCloseTo(400_000 / 60_000, 6);
    expect(e.batteryInKwh).toBeCloseTo((400_000 + 100_000) / 60_000, 6);
    expect(e.dieselKwh).toBe(0);
    expect(e.spanMs).toBe(120_000);
  });

  it('cuts the same rows into hourly and daily buckets', () => {
    const rows = [row(T, { solarW: 100_000 }), row(T + 60_000, { solarW: 100_000 })];
    expect(bucketEnergy(rows, 3_600_000)).toHaveLength(1);
    expect(bucketEnergy(rows, 60_000)).toHaveLength(2);
    expect(bucketEnergy(rows, 60_000)[1]!.solarKwh).toBeCloseTo(100 / 60, 6);
  });

  it('stops integrating across a gap longer than five minutes', () => {
    const rows = [row(T, { solarW: 600_000 }), row(T + 3_600_000, { solarW: 600_000 })];
    // 5 min + the last sample's own minute, not the hour the outage covered
    expect(energyOf(rows).spanMs).toBe(6 * 60_000);
    expect(energyOf(rows).solarKwh).toBeCloseTo(60, 6);
  });
});

// -------------------------------------------------------------- safeguards
describe('opg safeguards', () => {
  it('refuses a generator start below 2 % fuel', () => {
    const s = powerSamples({ diesel: { fuel_level_pct: 1.4 } });
    const blocked = spec(s, 'start_generator').guard!(guardInput('diesel', true));
    expect(blocked?.code).toBe('low_fuel');
    expect(blocked?.message).toContain('1.4 %');
  });

  it('refuses a generator start while they are already starting or running', () => {
    const starting = powerSamples({ diesel: { generator_status: 'starting', power_output_w: 0 } });
    expect(spec(starting, 'start_generator').guard!(guardInput('diesel', true))?.code).toBe('already_running');

    const running = powerSamples({ diesel: { generator_status: 'running', power_output_w: 120_000 } });
    expect(spec(running, 'start_generator').guard!(guardInput('diesel', true))?.code).toBe('already_running');
  });

  it('allows a start with fuel and the gensets off', () => {
    const s = powerSamples();
    expect(spec(s, 'start_generator').guard!(guardInput('diesel', true))).toBeNull();
  });

  it('refuses a stop when the generators are not running', () => {
    const s = powerSamples();
    expect(spec(s, 'stop_generator').guard!(guardInput('diesel', true))?.code).toBe('not_running');
  });

  it('asks for confirmation when stopping leaves the load uncovered', () => {
    const s = powerSamples({
      global: { total_generation_w: 220_000, total_load_w: 500_000 },
      solar: { power_output_w: 100_000 },
      diesel: { power_output_w: 220_000, generator_status: 'running' },
      batteries: { state_of_charge_pct: 25, battery_power_w: -320_000 },
    });
    const stop = spec(s, 'stop_generator');
    expect(stop.guard!(guardInput('diesel', true))).toBeNull();
    const need = stop.confirm!(confirmInput('diesel', true))!;
    expect(need.title).toContain('uncovered');
    // 500 kW of load against 100 kW of solar and 200 kW the bank can give for an hour
    expect(need.facts[0]).toContain('500 kW');
    expect(need.facts[1]).toContain('200 kW');
    expect(need.facts[2]).toContain('200 kW');
  });

  it('does not ask twice when solar and the bank cover the load', () => {
    const s = powerSamples({
      global: { total_generation_w: 300_000, total_load_w: 150_000 },
      solar: { power_output_w: 300_000 },
      diesel: { power_output_w: 0, generator_status: 'running' },
    });
    const stop = spec(s, 'stop_generator');
    expect(stop.guard!(guardInput('diesel', true))).toBeNull();
    expect(stop.confirm!(confirmInput('diesel', true))).toBeNull();
  });

  it('confirms disabling the array in daylight only', () => {
    const day = spec(powerSamples(), 'enable_solar_array');
    const need = day.confirm!(confirmInput('solar', false))!;
    expect(need.facts[0]).toContain('616 W/m²');
    expect(day.confirm!(confirmInput('solar', true))).toBeNull();

    const night = spec(powerSamples({ solar: { irradiance_wm2: 4, power_output_w: 0 } }), 'enable_solar_array');
    expect(night.confirm!(confirmInput('solar', false))).toBeNull();
  });

  it('rejects a reserve outside 10 to 80 %', () => {
    const reserve = spec(powerSamples(), 'battery_reserve');
    expect(reserve.schema.safeParse(9).success).toBe(false);
    expect(reserve.schema.safeParse(81).success).toBe(false);
    expect(reserve.schema.safeParse(50).success).toBe(true);
  });

  it('confirms a reserve at or above the current charge', () => {
    const reserve = spec(powerSamples(), 'battery_reserve');
    expect(reserve.confirm!(confirmInput('batteries', 71.2))).not.toBeNull();
    expect(reserve.confirm!(confirmInput('batteries', 50))).toBeNull();
  });

  it('accepts only the three documented priorities', () => {
    const priority = spec(powerSamples(), 'generation_priority');
    expect(priority.schema.safeParse('diesel_first').success).toBe(true);
    expect(priority.schema.safeParse('wind_first').success).toBe(false);
  });
});

// ----------------------------------------------------------------- presets
describe('opg presets', () => {
  it('ships storm prep, generator test and normal', () => {
    const presets = opgPresets().map((p) => ({ id: p.id, steps: p.steps }));
    expect(presets.map((p) => p.id)).toEqual(['opg-storm-prep', 'opg-generator-test', 'opg-normal']);

    const storm = presets[0]!;
    expect(storm.steps).toEqual([
      { entity: 'batteries', control: 'battery_reserve', value: 50 },
      { entity: 'global', control: 'load_shed', value: true },
    ]);

    const test = presets[1]!;
    expect(test.steps.map((s) => s.control)).toEqual(['generation_priority', 'start_generator']);
    expect(test.steps[0]!.value).toBe('diesel_first');

    const normal = presets[2]!;
    expect(normal.steps.find((s) => s.control === 'battery_reserve')!.value).toBe(DEFAULT_RESERVE_PCT);
    expect(normal.steps.find((s) => s.control === 'enable_solar_array')!.value).toBe(true);
  });
});
