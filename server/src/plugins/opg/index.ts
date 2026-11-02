// OPG plugin: plant state fold, power history, derived balances, controls/presets, SSE + REST.
// The four entities publish power every 60 s; everything else on the page is derived (see derive.ts).
import type { FastifyInstance } from 'fastify';
import type { CommandSpec, PresetSpec } from '../../commands/types.js';
import type { Parsed } from '../../core/parse.js';
import { BUCKET_MS } from '../../db/aggregates.js';
import type { Db } from '../../db/index.js';
import {
  bucketEnergy,
  energyOf,
  insertRefuel,
  loadPowerRows,
  loadRefuels,
  upsertPowerRow,
  type EnergyBucket,
  type EnergyTotals,
  type PowerHistoryRow,
} from '../../db/opg.js';
import { opgRoutes } from '../../routes/opg.js';
import { defaultExpectation } from '../generic.js';
import type { Kpi, PlatformContext, Plugin, StreamExpectation } from '../types.js';
import {
  DEFAULT_RESERVE_PCT,
  generatorsRunning,
  inDaylight,
  opgCommandSpecs,
  opgPresets,
  type OpgControlView,
} from './controls.js';
import { deriveOpg, irradianceAgreement, PLANT, type IrradianceAgreement, type OpgDerived } from './derive.js';
import { emptyOpgState, reduceOpg, type OpgRefuel, type OpgState } from './model.js';
import { isPowerSample, parseOpg, powerColumns } from './parse.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** ~1500 points on the chart: 14 days of minutes would be 20 k. */
const MAX_POINTS = 1500;
const MAX_REFUEL_MARKERS = 40;

export interface OpgSnapshotDTO {
  global: {
    generationW: number | null;
    loadW: number | null;
    supplyMode: string | null;
    generationPriority: string | null;
    loadShed: boolean | null;
    ts: number | null;
  };
  solar: {
    enabled: boolean | null;
    outputW: number | null;
    irradianceWm2: number | null;
    panelTemperatureK: number | null;
    inverterStatus: string | null;
    ts: number | null;
  };
  batteries: {
    socPct: number | null;
    powerW: number | null;
    temperatureK: number | null;
    healthPct: number | null;
    reservePct: number | null;
    ts: number | null;
  };
  diesel: {
    fuelPct: number | null;
    outputW: number | null;
    status: string | null;
    runtimeH: number | null;
    ts: number | null;
  };
  derived: OpgDerived;
  /** Plant ratings, so the gauges label themselves from one source. */
  plant: typeof PLANT;
  daylight: boolean;
  generatorsRunning: boolean;
  refuels: OpgRefuel[];
  ts: number | null;
}

export interface OpgTrendDTO {
  from: number;
  to: number;
  series: {
    ts: number[];
    solarW: (number | null)[];
    batteryW: (number | null)[];
    dieselW: (number | null)[];
    loadW: (number | null)[];
    socPct: (number | null)[];
    fuelPct: (number | null)[];
    irradianceWm2: (number | null)[];
  };
  energy: EnergyTotals & { renewableFraction: number | null };
  hourly: EnergyBucket[];
  daily: EnergyBucket[];
  /** Plant array irradiance against the LWM stations, paired on the same minute buckets. */
  correlation: IrradianceAgreement;
  refuels: OpgRefuel[];
  reservePct: number | null;
}

export class OpgPlugin implements Plugin {
  readonly id = 'opg' as const;
  state: OpgState = emptyOpgState();
  private ctx!: PlatformContext;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private specs: CommandSpec[] | null = null;

  get commands(): CommandSpec[] {
    return (this.specs ??= opgCommandSpecs(this.controlView));
  }

  get presets(): PresetSpec[] {
    return opgPresets();
  }

  private readonly controlView: OpgControlView = {
    state: this.state,
    derived: () => deriveOpg(this.state),
  };

  parse(topic: string, payload: Buffer, recvTs: number, retained: boolean): Parsed[] {
    return parseOpg(topic, payload, recvTs, retained);
  }

  init(ctx: PlatformContext): void {
    this.ctx = ctx;
    // refuel markers outlive a restart; the rest of the plant state comes back with the writer's replay
    this.state.refuels = loadRefuels(ctx.db, 0).slice(-MAX_REFUEL_MARKERS);
    ctx.sse.register('opg', () => ({ plant: this.plant() }));
    this.timer = setInterval(() => this.flushViews(), 500);
    this.timer.unref?.();
  }

  // ------------------------------------------------------------ fold + persist
  derive(p: Parsed): void {
    if (reduceOpg(this.state, p)) this.dirty = true;
  }

  persist(batch: Parsed[], db: Db): void {
    for (const p of batch) {
      if (p.kind === 'telemetry' && p.stream === 'power' && isPowerSample(p)) {
        const row = powerColumns(p);
        if (row) upsertPowerRow(db, row);
        continue;
      }
      if (p.kind === 'event' && p.event === 'refuel') {
        insertRefuel(db, {
          ts: p.simTs,
          litres: typeof p.body['litres'] === 'number' ? p.body['litres'] : null,
          fuelPct: typeof p.body['fuel_level_pct'] === 'number' ? p.body['fuel_level_pct'] : null,
        });
      }
    }
  }

  expectations(entity: { id: string; kind: string }): StreamExpectation | null {
    if (!ENTITY_IDS.has(entity.id)) return null;
    return defaultExpectation('opg', entity, this.ctx.topology, this.ctx.state);
  }

  kpis(): Kpi[] {
    const d = deriveOpg(this.state);
    const soc = this.state.batteries.socPct;
    const reserve = this.state.batteries.reservePct ?? DEFAULT_RESERVE_PCT;
    const kw = (w: number | null) => (w === null ? null : Math.round(w / 1000));
    return [
      { label: 'Generation', value: kw(this.state.global.totalGenerationW), unit: 'kW' },
      { label: 'Load', value: kw(this.state.global.totalLoadW), unit: 'kW' },
      {
        label: 'Renewable',
        value: d.renewableFraction === null ? null : Math.round(d.renewableFraction * 100),
        unit: '%',
        status: d.renewableFraction === null ? undefined : d.renewableFraction > 0.6 ? 'ok' : d.renewableFraction > 0.2 ? 'warn' : 'bad',
      },
      {
        label: 'SoC',
        value: soc === null ? null : Math.round(soc),
        unit: '%',
        status: soc === null ? undefined : soc <= reserve ? 'bad' : soc < reserve + 10 ? 'warn' : 'ok',
      },
      { label: 'Fuel left', value: d.dieselHoursLeftH === null ? null : Number(d.dieselHoursLeftH.toFixed(1)), unit: 'h' },
    ];
  }

  private simNow(): number | null {
    return this.ctx?.clock.now('opg') ?? null;
  }

  // ------------------------------------------------------------ views
  plant(): OpgSnapshotDTO {
    const s = this.state;
    const latest = [s.global.ts, s.solar.ts, s.batteries.ts, s.diesel.ts].filter((t): t is number => t !== null);
    return {
      global: {
        generationW: s.global.totalGenerationW,
        loadW: s.global.totalLoadW,
        supplyMode: s.global.supplyMode,
        generationPriority: s.global.generationPriority,
        loadShed: s.global.loadShed,
        ts: s.global.ts,
      },
      solar: {
        enabled: s.solar.enabled,
        outputW: s.solar.powerOutputW,
        irradianceWm2: s.solar.irradianceWm2,
        panelTemperatureK: s.solar.panelTemperatureK,
        inverterStatus: s.solar.inverterStatus,
        ts: s.solar.ts,
      },
      batteries: {
        socPct: s.batteries.socPct,
        powerW: s.batteries.powerW,
        temperatureK: s.batteries.temperatureK,
        healthPct: s.batteries.healthPct,
        reservePct: s.batteries.reservePct,
        ts: s.batteries.ts,
      },
      diesel: {
        fuelPct: s.diesel.fuelPct,
        outputW: s.diesel.powerOutputW,
        status: s.diesel.status,
        runtimeH: s.diesel.runtimeH,
        ts: s.diesel.ts,
      },
      derived: deriveOpg(s),
      plant: PLANT,
      daylight: inDaylight(s),
      generatorsRunning: generatorsRunning(s),
      refuels: s.refuels,
      ts: latest.length ? Math.max(...latest) : null,
    };
  }

  refuelList(): OpgRefuel[] {
    return this.state.refuels.slice(-MAX_REFUEL_MARKERS);
  }

  trend(hours: number): OpgTrendDTO {
    const db = this.ctx.db;
    const to = this.simNow() ?? Date.now();
    const from = to - hours * HOUR_MS;
    const rows = loadPowerRows(db, from, to);
    const stride = Math.max(1, Math.ceil(rows.length / MAX_POINTS));
    const series: OpgTrendDTO['series'] = {
      ts: [],
      solarW: [],
      batteryW: [],
      dieselW: [],
      loadW: [],
      socPct: [],
      fuelPct: [],
      irradianceWm2: [],
    };
    for (let i = 0; i < rows.length; i += stride) {
      const r = rows[i]!;
      series.ts.push(r.ts);
      series.solarW.push(r.solarW);
      series.batteryW.push(r.batteryW);
      series.dieselW.push(r.dieselW);
      series.loadW.push(r.loadW);
      series.socPct.push(r.socPct);
      series.fuelPct.push(r.fuelPct);
      series.irradianceWm2.push(r.irradianceWm2);
    }
    const totals = energyOf(rows);
    const loadKwh = totals.loadKwh;
    const energy = {
      ...totals,
      // surplus solar beyond the load is curtailed, so the share is capped at 100 %
      renewableFraction: loadKwh > 0 ? Math.min(1, totals.solarKwh / loadKwh) : null,
    };
    const refuels = loadRefuels(db, from);
    return {
      from,
      to,
      series,
      energy,
      hourly: bucketEnergy(rows, HOUR_MS),
      daily: bucketEnergy(rows, DAY_MS),
      correlation: irradianceAgreement(opgIrradiance(rows), lwmIrradiance(db, from)),
      refuels,
      reservePct: this.state.batteries.reservePct,
    };
  }

  private flushViews(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.ctx.sse.patch('opg', 'plant', this.plant());
  }

  snapshot(): unknown {
    return { plant: this.plant() };
  }

  routes(app: FastifyInstance): void {
    opgRoutes(app, this);
  }
}

const ENTITY_IDS = new Set(['global', 'solar', 'batteries', 'diesel']);

/** Minute buckets of the plant's own irradiance, floored so they pair with the aggregate buckets. */
function opgIrradiance(rows: PowerHistoryRow[]): { ts: number; wm2: number | null }[] {
  return rows
    .filter((r) => r.irradianceWm2 !== null)
    .map((r) => ({ ts: Math.floor(r.ts / BUCKET_MS) * BUCKET_MS, wm2: r.irradianceWm2 }));
}

/** Mean station irradiance from the aggregates the LWM plugin already writes. */
function lwmIrradiance(db: Db, from: number): { ts: number; wm2: number | null }[] {
  const rows = db
    .prepare(
      `SELECT bucket_ts, AVG(avg) AS v FROM aggregates WHERE service = 'lwm' AND metric = 'irradiance_wm2'
       AND bucket_ts >= ? GROUP BY bucket_ts ORDER BY bucket_ts`,
    )
    .all(from) as { bucket_ts: number; v: number | null }[];
  return rows.map((r) => ({ ts: r.bucket_ts, wm2: typeof r.v === 'number' ? r.v : null }));
}

export function createOpgPlugin(): OpgPlugin {
  return new OpgPlugin();
}
