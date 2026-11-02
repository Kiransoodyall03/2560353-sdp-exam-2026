// OPG state: one plant, four entities (global, solar, batteries, diesel). The fold is shared by live
// data and replay, so a restored snapshot gives the same numbers the page showed.
import type { Parsed } from '../../core/parse.js';

export interface OpgGlobal {
  generationPriority: string | null;
  loadShed: boolean | null;
  totalGenerationW: number | null;
  totalLoadW: number | null;
  supplyMode: string | null;
  ts: number | null;
}

export interface OpgSolar {
  enabled: boolean | null;
  powerOutputW: number | null;
  irradianceWm2: number | null;
  panelTemperatureK: number | null;
  inverterStatus: string | null;
  ts: number | null;
}

export interface OpgBatteries {
  socPct: number | null;
  powerW: number | null; // positive charging, negative discharging
  temperatureK: number | null;
  healthPct: number | null;
  reservePct: number | null;
  ts: number | null;
}

export interface OpgDiesel {
  fuelPct: number | null;
  powerOutputW: number | null;
  status: string | null; // off | starting | running | fault
  runtimeH: number | null;
  ts: number | null;
}

export interface OpgRefuel {
  ts: number;
  litres: number | null;
  fuelPct: number | null;
}

export interface OpgState {
  global: OpgGlobal;
  solar: OpgSolar;
  batteries: OpgBatteries;
  diesel: OpgDiesel;
  refuels: OpgRefuel[];
}

export function emptyOpgState(): OpgState {
  return {
    global: {
      generationPriority: null,
      loadShed: null,
      totalGenerationW: null,
      totalLoadW: null,
      supplyMode: null,
      ts: null,
    },
    solar: { enabled: null, powerOutputW: null, irradianceWm2: null, panelTemperatureK: null, inverterStatus: null, ts: null },
    batteries: { socPct: null, powerW: null, temperatureK: null, healthPct: null, reservePct: null, ts: null },
    diesel: { fuelPct: null, powerOutputW: null, status: null, runtimeH: null, ts: null },
    refuels: [],
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const MAX_REFUELS = 40;

/** Folds one parsed message into the plant state; returns true when something the UI shows changed. */
export function reduceOpg(s: OpgState, p: Parsed): boolean {
  if (p.kind === 'telemetry' && p.stream === 'power') {
    switch (p.entity) {
      case 'global': {
        const f = p.fields;
        s.global.totalGenerationW = num(f['total_generation_w']) ?? s.global.totalGenerationW;
        s.global.totalLoadW = num(f['total_load_w']) ?? s.global.totalLoadW;
        s.global.supplyMode = str(f['supply_mode']) ?? s.global.supplyMode;
        s.global.ts = p.simTs;
        return true;
      }
      case 'solar': {
        const f = p.fields;
        s.solar.powerOutputW = num(f['power_output_w']);
        s.solar.irradianceWm2 = num(f['irradiance_wm2']);
        s.solar.panelTemperatureK = num(f['panel_temperature_k']);
        s.solar.inverterStatus = str(f['inverter_status']);
        s.solar.ts = p.simTs;
        return true;
      }
      case 'batteries': {
        const f = p.fields;
        s.batteries.socPct = num(f['state_of_charge_pct']);
        s.batteries.powerW = num(f['battery_power_w']);
        s.batteries.temperatureK = num(f['battery_temperature_k']);
        s.batteries.healthPct = num(f['battery_health_pct']);
        s.batteries.ts = p.simTs;
        return true;
      }
      case 'diesel': {
        const f = p.fields;
        s.diesel.fuelPct = num(f['fuel_level_pct']);
        s.diesel.powerOutputW = num(f['power_output_w']);
        s.diesel.status = str(f['generator_status']);
        s.diesel.runtimeH = num(f['runtime_h']);
        s.diesel.ts = p.simTs;
        return true;
      }
      default:
        return false;
    }
  }
  if (p.kind === 'state') {
    if (p.entity === 'global' && p.item === 'generation_priority') {
      s.global.generationPriority = p.removed ? null : str(p.value);
      return true;
    }
    if (p.entity === 'global' && p.item === 'load_shed') {
      s.global.loadShed = p.removed ? null : bool(p.value);
      return true;
    }
    if (p.entity === 'solar' && p.item === 'enabled') {
      s.solar.enabled = p.removed ? null : bool(p.value);
      return true;
    }
    if (p.entity === 'batteries' && p.item === 'reserve_pct') {
      s.batteries.reservePct = p.removed ? null : num(p.value);
      return true;
    }
    return false;
  }
  if (p.kind === 'event' && p.event === 'refuel') {
    const litres = num(p.body['litres']);
    const fuelPct = num(p.body['fuel_level_pct']);
    if (litres === null && fuelPct === null) return false;
    s.refuels.push({ ts: p.simTs, litres, fuelPct });
    if (s.refuels.length > MAX_REFUELS) s.refuels.splice(0, s.refuels.length - MAX_REFUELS);
    if (fuelPct !== null) s.diesel.fuelPct = fuelPct;
    return true;
  }
  return false;
}

/** The same fold, for the plant: a refuel event that only carries the new level still records the event. */
export function lastRefuel(s: OpgState): OpgRefuel | null {
  return s.refuels.at(-1) ?? null;
}
