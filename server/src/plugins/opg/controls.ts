// OPG controls: zod value schemas, safeguards and presets. Pure functions over OpgState + the derived
// plant numbers, so the command service stays service-agnostic (same contract as plugins/rta/controls.ts).
import { z } from 'zod';
import { explainCommandReason } from '../../../../shared/commands.js';
import type { CommandSpec, ConfirmNeed, GuardBlock, PresetSpec } from '../../commands/types.js';
import { PLANT, type OpgDerived } from './derive.js';
import type { OpgState } from './model.js';

/** The slice of the plugin the safeguards need. */
export interface OpgControlView {
  readonly state: OpgState;
  /** Net balance, usable bank energy and fuel burn, recomputed from the current samples. */
  derived(): OpgDerived;
}

/** Reserve the array is delivered with (OPG spec §6, ARL_OPG_INITIAL_RESERVE_PCT). */
export const DEFAULT_RESERVE_PCT = 20;

const TrueOnly = z.literal(true);
const GenerationPriority = z.enum(['solar_first', 'battery_first', 'diesel_first']);
const ReservePct = z.number().min(10, 'below 10 %').max(80, 'above 80 %');

const block = (code: string, message?: string): GuardBlock => ({
  code,
  message: message ?? explainCommandReason(code) ?? code,
});

const confirm = (title: string, facts: string[]): ConfirmNeed => ({ title, facts });

const kw = (w: number | null): string => (w === null ? 'unknown' : `${(w / 1000).toFixed(0)} kW`);

/** True while the gensets are starting or running (the service rejects a second start either way). */
export function generatorsRunning(state: OpgState): boolean {
  const s = state.diesel.status;
  return s === 'running' || s === 'starting' || (state.diesel.powerOutputW ?? 0) > 0;
}

/** Daylight: enough irradiance for the array to be doing real work. */
export function inDaylight(state: OpgState): boolean {
  return (state.solar.irradianceWm2 ?? 0) >= PLANT.solarMinIrradianceWm2;
}

// ------------------------------------------------------------- safeguards
/** start_generator: refused below 2 % fuel or while the gensets are already up. */
function startGuard(view: OpgControlView): GuardBlock | null {
  const fuel = view.state.diesel.fuelPct;
  if (fuel !== null && fuel < PLANT.minFuelPct) {
    return block('low_fuel', `Fuel is at ${fuel.toFixed(1)} %: the generators cannot be started below ${PLANT.minFuelPct} %`);
  }
  if (generatorsRunning(view.state)) return block('already_running');
  return null;
}

function stopGuard(view: OpgControlView): GuardBlock | null {
  return generatorsRunning(view.state) ? null : block('not_running');
}

/**
 * Stopping the generators while the load is not covered by solar and the bank: the service accepts
 * this (it is a legitimate choice), so it is a confirmation, not a refusal.
 */
function stopConfirm(view: OpgControlView): ConfirmNeed | null {
  const d = view.derived();
  const load = view.state.global.totalLoadW;
  const solar = view.state.solar.powerOutputW;
  const available = d.availableBatteryW;
  if (load === null || load <= 0) return null;
  const covered = Math.max(0, solar ?? 0) + (available ?? 0);
  if (load <= covered) return null;
  return confirm('Stop the generators with the load uncovered?', [
    `Load is ${kw(load)}, solar output is ${kw(solar)}`,
    `The batteries can supply ${kw(available)} until they reach the ${(view.state.batteries.reservePct ?? DEFAULT_RESERVE_PCT).toFixed(0)} % reserve`,
    `Roughly ${kw(load - covered)} of load will be shed or lost once the generators stop`,
    'Send the command again to confirm (valid for 60 s)',
  ]);
}

/** Disabling the array while it is producing: the load falls to the batteries and the gensets. */
function solarConfirm(view: OpgControlView, value: unknown): ConfirmNeed | null {
  if (value !== false || !inDaylight(view.state)) return null;
  const d = view.derived();
  const output = view.state.solar.powerOutputW;
  return confirm('Disable the solar array in daylight?', [
    `The array is producing ${kw(output)} at ${(view.state.solar.irradianceWm2 ?? 0).toFixed(0)} W/m²`,
    `Renewable share drops from ${d.renewableFraction === null ? 'unknown' : `${Math.round(d.renewableFraction * 100)} %`} to 0`,
    `The ${kw(view.state.global.totalLoadW)} load falls to the batteries and the generators`,
    'Send the command again to confirm (valid for 60 s)',
  ]);
}

/** A reserve above the current charge strands energy: legal, but the operator should see it. */
function reserveConfirm(view: OpgControlView, value: unknown): ConfirmNeed | null {
  const soc = view.state.batteries.socPct;
  if (typeof value !== 'number' || soc === null || value < soc) return null;
  return confirm(`Keep ${value.toFixed(0)} % of the bank in reserve?`, [
    `The bank is at ${soc.toFixed(1)} %, at or below the new reserve`,
    `Usable energy drops to ${Math.max(0, soc - value).toFixed(1)} % of ${PLANT.batteryKwh} kWh`,
    'The generators will start as soon as the reserve is reached',
    'Send the command again to confirm (valid for 60 s)',
  ]);
}

// ----------------------------------------------------------------- specs
export function opgCommandSpecs(view: OpgControlView): CommandSpec[] {
  return [
    {
      control: 'generation_priority',
      entityKinds: ['service'],
      schema: GenerationPriority,
      ui: {
        label: 'Generation priority',
        kind: 'enum',
        options: [
          { value: 'solar_first', label: 'Solar first' },
          { value: 'battery_first', label: 'Battery first' },
          { value: 'diesel_first', label: 'Diesel first' },
        ],
        help: 'Order in which the sources cover the load; applies from the next minute',
      },
    },
    {
      control: 'load_shed',
      entityKinds: ['service'],
      schema: z.boolean(),
      ui: {
        label: 'Load shedding',
        kind: 'boolean',
        help: 'Sheds the housing and lab load and the water treatment plant',
      },
    },
    {
      control: 'enable_solar_array',
      entityKinds: ['array'],
      schema: z.boolean(),
      ui: {
        label: 'Solar array',
        kind: 'boolean',
        mayConfirm: true,
        help: 'Disabled, the inverter is offline and produces nothing',
      },
      confirm: ({ value }) => solarConfirm(view, value),
    },
    {
      control: 'battery_reserve',
      entityKinds: ['bank'],
      schema: ReservePct,
      ui: {
        label: 'Battery reserve',
        kind: 'number',
        min: 10,
        max: 80,
        unit: '%',
        mayConfirm: true,
        help: 'Minimum state of charge kept for emergencies',
      },
      confirm: ({ value }) => reserveConfirm(view, value),
    },
    {
      control: 'start_generator',
      entityKinds: ['generators'],
      schema: TrueOnly,
      ui: { label: 'Start generator', kind: 'boolean', help: 'Takes about 30 s to come up to speed' },
      guard: () => startGuard(view),
    },
    {
      control: 'stop_generator',
      entityKinds: ['generators'],
      schema: TrueOnly,
      ui: {
        label: 'Stop generator',
        kind: 'boolean',
        danger: true,
        mayConfirm: true,
        help: 'Stops the generators after a 60 s cool-down',
      },
      guard: () => stopGuard(view),
      confirm: () => stopConfirm(view),
    },
  ];
}

/**
 * Static presets. `Normal` restores the start-up configuration, so an operator who has been chasing
 * a storm can put the plant back without remembering four separate controls.
 */
export function opgPresets(): PresetSpec[] {
  return [
    {
      id: 'opg-storm-prep',
      name: 'Storm prep',
      description: 'Keeps 50 % of the bank in reserve and sheds the non-critical load before the gust arrives',
      steps: [
        { entity: 'batteries', control: 'battery_reserve', value: 50 },
        { entity: 'global', control: 'load_shed', value: true },
      ],
    },
    {
      id: 'opg-generator-test',
      name: 'Generator test',
      description: 'Loads the gensets first and starts them for a run-up test',
      steps: [
        { entity: 'global', control: 'generation_priority', value: 'diesel_first' },
        { entity: 'diesel', control: 'start_generator', value: true },
      ],
    },
    {
      id: 'opg-normal',
      name: 'Normal',
      description: 'Solar first, no shedding, array enabled and the reserve back to 20 %',
      steps: [
        { entity: 'global', control: 'generation_priority', value: 'solar_first' },
        { entity: 'global', control: 'load_shed', value: false },
        { entity: 'solar', control: 'enable_solar_array', value: true },
        { entity: 'batteries', control: 'battery_reserve', value: DEFAULT_RESERVE_PCT },
      ],
    },
  ];
}
