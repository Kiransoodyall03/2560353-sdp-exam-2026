// OPG live view: one SSE channel carries the whole plant (snapshot on connect, then a `plant` patch
// each minute). Everything derived on the page comes from the server, never recomputed here.
import { useState } from 'react';
import { useSse, type SseStatus } from './sse';

export interface OpgDerived {
  netW: number | null;
  renewableFraction: number | null;
  solarExpectedW: number | null;
  solarPerformanceRatio: number | null;
  solarHeadroomW: number | null;
  storedKwh: number | null;
  usableKwh: number | null;
  timeToReserveH: number | null;
  fuelLitres: number | null;
  burnLph: number | null;
  dieselHoursLeftH: number | null;
  availableBatteryW: number | null;
  uncoveredW: number | null;
  shortfall: boolean;
}

export interface OpgPlant {
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
  plant: {
    solarKwp: number;
    inverterKw: number;
    batteryKwh: number;
    batteryMaxKw: number;
    generators: number;
    generatorKw: number;
    fuelTankL: number;
  };
  daylight: boolean;
  generatorsRunning: boolean;
  refuels: { ts: number; litres: number | null; fuelPct: number | null }[];
  ts: number | null;
}

export interface OpgEnergy {
  solarKwh: number;
  batteryInKwh: number;
  batteryOutKwh: number;
  dieselKwh: number;
  loadKwh: number;
  spanMs: number;
  renewableFraction: number | null;
}

export interface OpgBucket extends OpgEnergy {
  ts: number;
}

export interface OpgTrend {
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
  energy: OpgEnergy;
  hourly: OpgBucket[];
  daily: OpgBucket[];
  correlation: { n: number; r: number | null; biasWm2: number | null; opgMeanWm2: number | null; lwmMeanWm2: number | null };
  refuels: { ts: number; litres: number | null; fuelPct: number | null }[];
  reservePct: number | null;
}

export function useOpgLive(): { plant: OpgPlant | null; status: SseStatus } {
  const [plant, setPlant] = useState<OpgPlant | null>(null);
  const status = useSse('opg', (env) => {
    const data = env.data as { plant?: OpgPlant };
    if (env.type === 'snapshot') setPlant(data.plant ?? null);
    else if (env.type === 'patch' && data.plant) setPlant(data.plant);
  });
  return { plant, status };
}

/** kW with a fixed 0 decimals; the plant runs in the hundreds of kW. */
export const kw = (w: number | null | undefined): string => (w == null ? '—' : `${Math.round(w / 1000)} kW`);

export const pct = (v: number | null | undefined, digits = 1): string => (v == null ? '—' : `${v.toFixed(digits)} %`);
