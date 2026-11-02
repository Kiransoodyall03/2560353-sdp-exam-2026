// Derived plant numbers. Nothing here is published by the simulator: the net balance, renewable
// fraction, solar performance ratio, battery time-to-reserve and diesel hours left are all computed
// from the four power samples plus the documented plant ratings (OPG spec §1, §5.0.2).
import type { OpgState } from './model.js';

/** Plant ratings from the OPG spec; the simulator is configured with the same numbers. */
export const PLANT = {
  solarKwp: 1200,
  inverterKw: 1000,
  batteryKwh: 4000,
  batteryMaxKw: 800,
  generators: 2,
  generatorKw: 250,
  fuelTankL: 20_000,
  /** Specific fuel consumption of a part-loaded diesel genset, litres per kWh. */
  dieselLPerKwh: 0.27,
  /** A running generator burns this even with no load. */
  dieselIdleLph: 4,
  /** Below this the solar array cannot be judged on its irradiance (dawn/dusk). */
  solarMinIrradianceWm2: 50,
  /** The service rejects a generator start below this fuel level. */
  minFuelPct: 2,
} as const;

export interface OpgDerived {
  /** Generation minus load; positive means the surplus is charging the batteries. */
  netW: number | null;
  /** Share of the load the solar array covers (0..1); surplus solar beyond the load is not counted. */
  renewableFraction: number | null;
  /** What the array should produce at the measured irradiance (DC, capped by the inverter). */
  solarExpectedW: number | null;
  /** Actual output ÷ irradiance-expected output; < 1 means soiling, heat or a string fault. */
  solarPerformanceRatio: number | null;
  /** Inverter rating minus current output: room for more solar. */
  solarHeadroomW: number | null;
  storedKwh: number | null;
  /** Energy above the reserve the plant is allowed to use. */
  usableKwh: number | null;
  /** Hours until the bank reaches its reserve at the current discharge rate (null when not discharging). */
  timeToReserveH: number | null;
  fuelLitres: number | null;
  /** Litres per hour at the current output (null when the generators are off). */
  burnLph: number | null;
  /** Hours of fuel left at the current burn rate (null when the generators are off). */
  dieselHoursLeftH: number | null;
  /** Discharge the bank can sustain for an hour before reaching its reserve. */
  availableBatteryW: number | null;
  /** Load left once solar and the running generators are counted (never negative). */
  uncoveredW: number | null;
  /** True when the load is not covered by solar + diesel + the battery bank. */
  shortfall: boolean;
}

const num = (v: number | null): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function deriveOpg(s: OpgState): OpgDerived {
  const solarW = num(s.solar.powerOutputW);
  const batteryW = num(s.batteries.powerW);
  const dieselW = num(s.diesel.powerOutputW);
  const loadW = num(s.global.totalLoadW);
  const generationW = num(s.global.totalGenerationW);
  const soc = num(s.batteries.socPct);
  const reserve = num(s.batteries.reservePct);
  const irradiance = num(s.solar.irradianceWm2);
  const fuelPct = num(s.diesel.fuelPct);

  const netW = generationW === null || loadW === null ? null : generationW - loadW;

  const renewableFraction =
    solarW === null || loadW === null ? null : loadW <= 0 ? null : clamp(Math.min(solarW, loadW) / loadW, 0, 1);

  // irradiance → expected DC power, then the inverter caps what can be delivered
  const expectedDc =
    irradiance === null || irradiance < PLANT.solarMinIrradianceWm2
      ? null
      : (irradiance / 1000) * PLANT.solarKwp * 1000;
  const solarExpectedW =
    expectedDc === null ? null : Math.min(expectedDc, PLANT.inverterKw * 1000);
  const solarPerformanceRatio =
    solarExpectedW === null || solarW === null || solarExpectedW < 1
      ? null
      : clamp(solarW / solarExpectedW, 0, 1.5);
  const solarHeadroomW = solarW === null ? null : PLANT.inverterKw * 1000 - solarW;

  const storedKwh = soc === null ? null : (soc / 100) * PLANT.batteryKwh;
  const usableKwh = soc === null ? null : (Math.max(0, soc - (reserve ?? 0)) / 100) * PLANT.batteryKwh;
  const timeToReserveH =
    soc === null || reserve === null || batteryW === null || batteryW >= 0
      ? null
      : soc <= reserve
        ? 0
        : usableKwh! / (-batteryW / 1000);
  const availableBatteryW =
    soc === null
      ? null
      : Math.min(
          PLANT.batteryMaxKw * 1000,
          (Math.max(0, soc - (reserve ?? 0)) / 100) * PLANT.batteryKwh * 1000, // one hour at that rate
        );

  const fuelLitres = fuelPct === null ? null : (fuelPct / 100) * PLANT.fuelTankL;
  const outputKw = dieselW === null ? null : dieselW / 1000;
  const running = s.diesel.status === 'running' || s.diesel.status === 'starting' || (dieselW ?? 0) > 0;
  const burnLph =
    outputKw === null ? null : running ? Math.max(PLANT.dieselIdleLph, outputKw * PLANT.dieselLPerKwh) : null;
  const dieselHoursLeftH = fuelLitres === null || burnLph === null || burnLph <= 0 ? null : fuelLitres / burnLph;

  const uncoveredW = loadW === null ? null : Math.max(0, loadW - Math.max(0, solarW ?? 0) - Math.max(0, dieselW ?? 0));
  const shortfall =
    uncoveredW !== null &&
    uncoveredW > 0 &&
    // discharging counts as supply until the bank hits its reserve
    (availableBatteryW === null || uncoveredW > availableBatteryW);

  return {
    netW,
    renewableFraction,
    solarExpectedW,
    solarPerformanceRatio,
    solarHeadroomW,
    storedKwh,
    usableKwh,
    timeToReserveH,
    fuelLitres,
    burnLph,
    dieselHoursLeftH,
    availableBatteryW,
    uncoveredW,
    shortfall,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Pearson correlation; null when there are fewer than three pairs or one side is flat. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

export interface IrradiancePoint {
  ts: number;
  wm2: number | null;
}

export interface IrradianceAgreement {
  /** Aligned samples used. */
  n: number;
  /** Pearson r between the plant's array irradiance and the weather station mean. */
  r: number | null;
  /** Mean plant − mean station, W/m²: positive means the array sees more sun than the stations. */
  biasWm2: number | null;
  opgMeanWm2: number | null;
  lwmMeanWm2: number | null;
}

/**
 * OPG irradiance against the LWM stations, paired on the minute buckets both sides recorded. The
 * array sits among the stations, so a low r or a large bias points at a sensor or soiling problem.
 */
export function irradianceAgreement(opg: IrradiancePoint[], lwm: IrradiancePoint[]): IrradianceAgreement {
  const byTs = new Map<number, number>();
  for (const p of lwm) if (p.wm2 !== null && Number.isFinite(p.wm2)) byTs.set(p.ts, p.wm2);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of opg) {
    if (p.wm2 === null || !Number.isFinite(p.wm2)) continue;
    const l = byTs.get(p.ts);
    if (l === undefined) continue;
    xs.push(p.wm2);
    ys.push(l);
  }
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const opgMean = mean(xs);
  const lwmMean = mean(ys);
  return {
    n: xs.length,
    r: pearson(xs, ys),
    biasWm2: opgMean === null || lwmMean === null ? null : opgMean - lwmMean,
    opgMeanWm2: opgMean,
    lwmMeanWm2: lwmMean,
  };
}
