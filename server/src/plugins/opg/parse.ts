// OPG parsing: the shared envelope parser plus the plant's own view of a power sample. Field names
// come from the OPG spec §2.1; a missing measurement is null (the spec allows it), not an error.
import { z } from 'zod';
import { parseMessage, type Parsed, type ParsedTelemetry } from '../../core/parse.js';

const Num = z.number().finite().nullable().optional();

const GlobalPower = z
  .object({
    total_generation_w: Num,
    total_load_w: Num,
    supply_mode: z.enum(['solar', 'battery', 'diesel', 'mixed']).nullable().optional(),
  })
  .passthrough();

const SolarPower = z
  .object({
    power_output_w: Num,
    irradiance_wm2: Num,
    panel_temperature_k: Num,
    inverter_status: z.enum(['online', 'offline', 'fault']).nullable().optional(),
  })
  .passthrough();

const BatteryPower = z
  .object({
    state_of_charge_pct: Num,
    battery_power_w: Num,
    battery_temperature_k: Num,
    battery_health_pct: Num,
  })
  .passthrough();

const DieselPower = z
  .object({
    fuel_level_pct: Num,
    power_output_w: Num,
    generator_status: z.enum(['off', 'starting', 'running', 'fault']).nullable().optional(),
    runtime_h: Num,
  })
  .passthrough();

export const POWER_ENTITIES = ['global', 'solar', 'batteries', 'diesel'] as const;
export type PowerEntity = (typeof POWER_ENTITIES)[number];

/** Someone else's topics are dropped: the platform routes by service, this is the second guard. */
export function parseOpg(topic: string, payload: Buffer, recvTs: number, retained: boolean): Parsed[] {
  if (topic.split('/')[1] !== 'opg') return [];
  return [parseMessage(topic, payload, recvTs, retained)];
}

export interface PowerRow {
  ts: number;
  /** Only the columns this entity owns are set; the store upserts them into the minute's row. */
  solarW?: number | null;
  batteryW?: number | null;
  dieselW?: number | null;
  loadW?: number | null;
  generationW?: number | null;
  socPct?: number | null;
  fuelPct?: number | null;
  irradianceWm2?: number | null;
}

/** True when the message is a well-formed power sample for one of the plant's entities. */
export function isPowerSample(p: Parsed): p is ParsedTelemetry {
  if (p.kind !== 'telemetry' || p.stream !== 'power') return false;
  if (!(POWER_ENTITIES as readonly string[]).includes(p.entity)) return false;
  return sampleOf(p) !== null;
}

/** Validated fields of a power sample, or null when the payload is not one of the documented shapes. */
export function sampleOf(p: ParsedTelemetry): Record<string, number | string | null> | null {
  switch (p.entity) {
    case 'global': {
      const r = GlobalPower.safeParse(p.fields);
      if (!r.success) return null;
      return {
        total_generation_w: r.data.total_generation_w ?? null,
        total_load_w: r.data.total_load_w ?? null,
        supply_mode: r.data.supply_mode ?? null,
      };
    }
    case 'solar': {
      const r = SolarPower.safeParse(p.fields);
      if (!r.success) return null;
      return {
        power_output_w: r.data.power_output_w ?? null,
        irradiance_wm2: r.data.irradiance_wm2 ?? null,
        panel_temperature_k: r.data.panel_temperature_k ?? null,
        inverter_status: r.data.inverter_status ?? null,
      };
    }
    case 'batteries': {
      const r = BatteryPower.safeParse(p.fields);
      if (!r.success) return null;
      return {
        state_of_charge_pct: r.data.state_of_charge_pct ?? null,
        battery_power_w: r.data.battery_power_w ?? null,
        battery_temperature_k: r.data.battery_temperature_k ?? null,
        battery_health_pct: r.data.battery_health_pct ?? null,
      };
    }
    case 'diesel': {
      const r = DieselPower.safeParse(p.fields);
      if (!r.success) return null;
      return {
        fuel_level_pct: r.data.fuel_level_pct ?? null,
        power_output_w: r.data.power_output_w ?? null,
        generator_status: r.data.generator_status ?? null,
        runtime_h: r.data.runtime_h ?? null,
      };
    }
    default:
      return null;
  }
}

/**
 * The columns one power sample contributes to its minute. Each entity owns a few columns, so the
 * store upserts instead of relying on the four messages arriving in any particular order.
 */
export function powerColumns(p: ParsedTelemetry): PowerRow | null {
  const f = sampleOf(p);
  if (!f) return null;
  const n = (k: string) => (typeof f[k] === 'number' ? (f[k] as number) : null);
  switch (p.entity) {
    case 'global':
      return { ts: p.simTs, loadW: n('total_load_w'), generationW: n('total_generation_w') };
    case 'solar':
      return { ts: p.simTs, solarW: n('power_output_w'), irradianceWm2: n('irradiance_wm2') };
    case 'batteries':
      return { ts: p.simTs, batteryW: n('battery_power_w'), socPct: n('state_of_charge_pct') };
    case 'diesel':
      return { ts: p.simTs, dieselW: n('power_output_w'), fuelPct: n('fuel_level_pct') };
    default:
      return null;
  }
}
