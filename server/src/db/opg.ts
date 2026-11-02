// OPG persistence: one row per simulated minute for the whole plant (each entity upserts its own
// columns) plus the refuel deliveries. Energy is integrated here so the page and the tests share it.
import type { PowerRow } from '../plugins/opg/parse.js';
import type { OpgRefuel } from '../plugins/opg/model.js';
import type { Db } from './index.js';

type Column =
  | 'solar_w'
  | 'battery_w'
  | 'diesel_w'
  | 'load_w'
  | 'generation_w'
  | 'soc_pct'
  | 'fuel_pct'
  | 'irradiance_wm2';

const COLUMN_OF: Record<keyof Omit<PowerRow, 'ts'>, Column> = {
  solarW: 'solar_w',
  batteryW: 'battery_w',
  dieselW: 'diesel_w',
  loadW: 'load_w',
  generationW: 'generation_w',
  socPct: 'soc_pct',
  fuelPct: 'fuel_pct',
  irradianceWm2: 'irradiance_wm2',
};

/** Upserts only the columns the sample owns, so message order between entities does not matter. */
export function upsertPowerRow(db: Db, row: PowerRow): void {
  const sets: string[] = [];
  const values: (number | null)[] = [];
  for (const [key, column] of Object.entries(COLUMN_OF) as [keyof Omit<PowerRow, 'ts'>, Column][]) {
    const v = row[key];
    if (v === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  db.prepare(
    `INSERT INTO opg_power (sim_ts, ${sets.map((s) => s.split(' =')[0]).join(', ')})
     VALUES (?, ${sets.map(() => '?').join(', ')})
     ON CONFLICT (sim_ts) DO UPDATE SET ${sets.join(', ')}`,
  ).run(row.ts, ...values, ...values);
}

export function insertRefuel(db: Db, r: OpgRefuel): void {
  db.prepare(
    `INSERT INTO opg_refuels (sim_ts, litres, fuel_level_pct) VALUES (?, ?, ?)
     ON CONFLICT (sim_ts) DO UPDATE SET litres = excluded.litres, fuel_level_pct = excluded.fuel_level_pct`,
  ).run(r.ts, r.litres, r.fuelPct);
}

export interface PowerHistoryRow {
  ts: number;
  solarW: number | null;
  batteryW: number | null;
  dieselW: number | null;
  loadW: number | null;
  generationW: number | null;
  socPct: number | null;
  fuelPct: number | null;
  irradianceWm2: number | null;
}

const NULL_SAFE = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function loadPowerRows(db: Db, from: number, to: number): PowerHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT sim_ts, solar_w, battery_w, diesel_w, load_w, generation_w, soc_pct, fuel_pct, irradiance_wm2
       FROM opg_power WHERE sim_ts >= ? AND sim_ts <= ? ORDER BY sim_ts`,
    )
    .all(from, to) as Record<string, unknown>[];
  return rows.map((r) => ({
    ts: Number(r['sim_ts']),
    solarW: NULL_SAFE(r['solar_w']),
    batteryW: NULL_SAFE(r['battery_w']),
    dieselW: NULL_SAFE(r['diesel_w']),
    loadW: NULL_SAFE(r['load_w']),
    generationW: NULL_SAFE(r['generation_w']),
    socPct: NULL_SAFE(r['soc_pct']),
    fuelPct: NULL_SAFE(r['fuel_pct']),
    irradianceWm2: NULL_SAFE(r['irradiance_wm2']),
  }));
}

export function loadRefuels(db: Db, from = 0): OpgRefuel[] {
  const rows = db
    .prepare('SELECT sim_ts, litres, fuel_level_pct FROM opg_refuels WHERE sim_ts >= ? ORDER BY sim_ts')
    .all(from) as { sim_ts: number; litres: number | null; fuel_level_pct: number | null }[];
  return rows.map((r) => ({ ts: r.sim_ts, litres: r.litres, fuelPct: r.fuel_level_pct }));
}

export interface EnergyTotals {
  solarKwh: number;
  batteryInKwh: number;
  batteryOutKwh: number;
  dieselKwh: number;
  loadKwh: number;
  /** Duration actually covered by samples, ms. */
  spanMs: number;
}

const STEP_MS = 60_000;
const MAX_STEP_MS = 5 * 60_000;

/** Trapezoidal-enough integration: every sample stands for the time until the next one (≤ 5 min). */
export function energyOf(rows: PowerHistoryRow[]): EnergyTotals {
  return bucketEnergy(rows, 0).reduce<EnergyTotals>(
    (acc, b) => ({
      solarKwh: acc.solarKwh + b.solarKwh,
      batteryInKwh: acc.batteryInKwh + b.batteryInKwh,
      batteryOutKwh: acc.batteryOutKwh + b.batteryOutKwh,
      dieselKwh: acc.dieselKwh + b.dieselKwh,
      loadKwh: acc.loadKwh + b.loadKwh,
      spanMs: acc.spanMs + b.spanMs,
    }),
    { solarKwh: 0, batteryInKwh: 0, batteryOutKwh: 0, dieselKwh: 0, loadKwh: 0, spanMs: 0 },
  );
}

export interface EnergyBucket extends EnergyTotals {
  ts: number;
}

/**
 * The same integration, cut into buckets of `sizeMs` (0 = one bucket for the whole window). A sample
 * belongs to the bucket its own timestamp falls in, which is what the hourly and daily charts plot.
 */
export function bucketEnergy(rows: PowerHistoryRow[], sizeMs: number): EnergyBucket[] {
  const buckets = new Map<number, EnergyBucket>();
  const empty = (ts: number): EnergyBucket => ({
    ts,
    solarKwh: 0,
    batteryInKwh: 0,
    batteryOutKwh: 0,
    dieselKwh: 0,
    loadKwh: 0,
    spanMs: 0,
  });
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const next = rows[i + 1];
    const dt = Math.min(next ? next.ts - r.ts : STEP_MS, MAX_STEP_MS);
    if (!(dt > 0)) continue;
    const key = sizeMs > 0 ? Math.floor(r.ts / sizeMs) * sizeMs : 0;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = empty(key)));
    const hours = dt / 3_600_000;
    b.spanMs += dt;
    b.solarKwh += (Math.max(0, r.solarW ?? 0) * hours) / 1000;
    const batt = r.batteryW ?? 0;
    if (batt >= 0) b.batteryInKwh += (batt * hours) / 1000;
    else b.batteryOutKwh += (-batt * hours) / 1000;
    b.dieselKwh += (Math.max(0, r.dieselW ?? 0) * hours) / 1000;
    b.loadKwh += (Math.max(0, r.loadW ?? 0) * hours) / 1000;
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

