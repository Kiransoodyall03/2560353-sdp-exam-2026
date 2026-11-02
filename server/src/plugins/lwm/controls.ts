// LWM controls: zod value schemas, safeguards and presets. Pure functions over LwmState plus the
// derived numbers, so the generic command service stays service-agnostic (same contract as the RTA and
// OPG plugins). The safeguards come from the LWM spec §3: technician visits are refused while lightning
// is close, a recalibration is refused in high wind or while a site is replaying buffered samples, and
// a pan refill is refused once the pan is already full enough.
import { z } from 'zod';
import { explainCommandReason } from '../../../../shared/commands.js';
import type { CommandSpec, ConfirmNeed, GuardBlock, PresetSpec } from '../../commands/types.js';
import type { LwmDerived, LwmLimits } from './derive.js';
import type { LwmState } from './model.js';
import { SITE_IDS } from './model.js';

/** The slice of the plugin the safeguards need. */
export interface LwmControlView {
  readonly state: LwmState;
  /** Dew point, battery forecast, storm approach …, recomputed from the current samples. */
  derived(): LwmDerived;
  /** Alert limits (from the API when published, else the spec defaults). */
  limits(): LwmLimits;
}

/** A pan above this is full enough that a refill would be wasted (spec §3, refill_pan). */
export const REFILL_NOT_NEEDED_MM = 195;
/** refill_pan tops the pan up to this (spec §3). */
export const REFILL_TARGET_MM = 205;

/** Below this a sample interval counts as "short" for the low-battery confirmation. */
const SHORT_INTERVAL_S = 30;
/** A battery this far above battery.min_v already counts as low. */
const LOW_BATTERY_MARGIN_V = 0.5;
/** Confirm a short interval when the pack would cross the limit inside this many hours. */
const SHORT_INTERVAL_BATTERY_H = 6;

const TrueOnly = z.literal(true);
const SampleInterval = z
  .number()
  .int('whole seconds only')
  .min(10, 'below the 10 s minimum')
  .max(3600, 'above the 3600 s maximum')
  .multipleOf(10, 'a multiple of 10 s');

const block = (code: string, message?: string): GuardBlock => ({
  code,
  message: message ?? explainCommandReason(code) ?? code,
});

const confirm = (title: string, facts: string[]): ConfirmNeed => ({ title, facts });

/** Lightning Proximity is active: the alert is raised, or a strike is inside lightning.max_km right now. */
export function lightningActive(view: LwmControlView): boolean {
  const alerts = view.state.global.activeAlerts;
  if (alerts?.some((a) => a.includes('lightning_proximity'))) return true;
  return view.derived().lightning.withinMaxKm;
}

// ------------------------------------------------------------- safeguards
/** service_anemometer / clean_reference_cell / refill_pan: no technician visit while lightning is close. */
function technicianGuard(view: LwmControlView): GuardBlock | null {
  return lightningActive(view) ? block('lightning_proximity') : null;
}

/** request_recalibration: refused while the site is catching up on buffered samples or in high wind. */
function recalibrationGuard(view: LwmControlView, entity: string): GuardBlock | null {
  const site = view.state.sites[entity];
  if (!site) return block('unknown_target');
  if (site.backfilling) return block('backfill_in_progress');
  const gust = site.latest?.windGustMs ?? null;
  const warn = view.limits().highWindWarnMs;
  if (gust !== null && gust > warn) {
    return block('sensor_disturbed', `The gust is ${gust.toFixed(1)} m/s, above the ${warn} m/s High Wind warning limit`);
  }
  return null;
}

/** refill_pan: refused while lightning is close, or once the pan is already above 195 mm. */
function refillPanGuard(view: LwmControlView, entity: string): GuardBlock | null {
  const tech = technicianGuard(view);
  if (tech) return tech;
  const level = view.state.sites[entity]?.pan?.panLevelMm ?? null;
  if (level !== null && level > REFILL_NOT_NEEDED_MM) {
    return block('not_needed', `The pan is at ${level.toFixed(1)} mm, above the ${REFILL_NOT_NEEDED_MM} mm refill threshold`);
  }
  return null;
}

/** A short sample interval on a site whose battery is already low (or will run down soon): confirm. */
function sampleIntervalConfirm(view: LwmControlView, entity: string, value: unknown): ConfirmNeed | null {
  if (typeof value !== 'number' || value >= SHORT_INTERVAL_S) return null;
  const limits = view.limits();
  const battery = view.derived().sites[entity]?.battery;
  const v = battery?.batteryV ?? null;
  const low = v !== null && v <= limits.batteryMinV + LOW_BATTERY_MARGIN_V;
  const hours = battery?.hoursToMin ?? null;
  const soon = hours !== null && hours < SHORT_INTERVAL_BATTERY_H;
  if (!low && !soon) return null;
  return confirm(`Sample ${entity} every ${value} s on a low battery?`, [
    v !== null
      ? `The battery is at ${v.toFixed(2)} V (the alert limit is ${limits.batteryMinV.toFixed(1)} V)`
      : 'The battery voltage is not known yet',
    hours !== null
      ? `At the current drain it reaches the limit in about ${hours.toFixed(1)} h; a ${value} s interval drains it faster`
      : `A ${value} s interval drains the battery faster than the default`,
    'Send the command again to confirm (valid for 60 s)',
  ]);
}

// ----------------------------------------------------------------- specs
export function lwmCommandSpecs(view: LwmControlView): CommandSpec[] {
  return [
    {
      control: 'enable_site',
      entityKinds: ['site'],
      schema: z.boolean(),
      ui: { label: 'Site enabled', kind: 'boolean', help: 'Take the site in or out of service' },
    },
    {
      control: 'sample_interval',
      entityKinds: ['site'],
      schema: SampleInterval,
      ui: {
        label: 'Sample interval',
        kind: 'number',
        min: 10,
        max: 3600,
        unit: 's',
        mayConfirm: true,
        help: 'How often the site samples (10–3600 s, multiples of 10); short intervals drain the battery faster',
      },
      confirm: ({ entity, value }) => sampleIntervalConfirm(view, entity, value),
    },
    {
      control: 'request_recalibration',
      entityKinds: ['site'],
      schema: TrueOnly,
      ui: {
        label: 'Request recalibration',
        kind: 'boolean',
        help: 'Recalibrates the sensors (60 s); refused in high wind or while the site replays buffered samples',
      },
      guard: ({ entity }) => recalibrationGuard(view, entity),
    },
    {
      control: 'service_anemometer',
      entityKinds: ['site'],
      schema: TrueOnly,
      ui: {
        label: 'Service anemometer',
        kind: 'boolean',
        help: 'Technician visit to service the anemometer (30–120 min); refused while lightning is close',
      },
      guard: () => technicianGuard(view),
    },
    {
      control: 'clean_reference_cell',
      entityKinds: ['site'],
      schema: TrueOnly,
      ui: {
        label: 'Clean reference cell',
        kind: 'boolean',
        entities: ['lwm-4'],
        help: 'Technician visit to clean the soiling reference cell (30–120 min); refused while lightning is close',
      },
      guard: () => technicianGuard(view),
    },
    {
      control: 'refill_pan',
      entityKinds: ['site'],
      schema: TrueOnly,
      ui: {
        label: 'Refill pan',
        kind: 'boolean',
        entities: ['lwm-5'],
        help: `Technician visit to top the evaporation pan to ${REFILL_TARGET_MM} mm (5 min); refused above ${REFILL_NOT_NEEDED_MM} mm or while lightning is close`,
      },
      guard: ({ entity }) => refillPanGuard(view, entity),
    },
  ];
}

/**
 * Static presets: each one sets the sample interval on all five sites at once, so an operator chasing a
 * storm (or conserving battery through a lull) does not have to touch every site by hand.
 */
export function lwmPresets(): PresetSpec[] {
  const interval = (id: string, name: string, description: string, seconds: number): PresetSpec => ({
    id,
    name,
    description,
    steps: SITE_IDS.map((site) => ({ entity: site, control: 'sample_interval', value: seconds })),
  });
  return [
    interval('lwm-storm-watch', 'Storm watch', 'Samples every site every 10 s to catch the storm in detail (drains batteries faster)', 10),
    interval('lwm-battery-saver', 'Battery saver', 'Samples every site every 600 s to conserve battery through a long lull', 600),
    interval('lwm-normal', 'Normal', 'Returns every site to the default 60 s sample interval', 60),
  ];
}
