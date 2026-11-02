// RTA controls: zod value schemas, safeguards and presets. Pure functions over RtaState + the
// catalogue/limits exposed by the plugin, so the command service stays service-agnostic.
import { z } from 'zod';
import { explainCommandReason } from '../../../../shared/commands.js';
import type { CommandSpec, ConfirmNeed, GuardBlock, PresetSpec } from '../../commands/types.js';
import { altitudeDeg } from './astro.js';
import type { RtaDish, RtaState, RtaSubarray } from './model.js';

/** The slice of the plugin the safeguards need. */
export interface RtaControlView {
  readonly state: RtaState;
  simNow(): number | null;
  resolveTarget(id: string): { ra_rad: number; dec_rad: number; fov_rad: number } | null;
  hasTarget(id: string): boolean;
  /** Mean dish position from $topology (null until the first topology arrives). */
  site(): { lat: number; lon: number } | null;
  minActive(): number;
}

export const TARGET_MIN_ALT_DEG = 15;
export const MIN_SCAN_DISHES = 3;
export const MAX_SUBARRAYS = 4;

const TAU = Math.PI * 2;
const SCANNING_STATES = new Set(['running', 'paused']);

// ------------------------------------------------------------------ values
const TrueOnly = z.literal(true);
const SubarrayName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,15}$/, 'use 1-16 lowercase letters, digits or dashes, starting with a letter')
  .refine((v) => !v.startsWith('dish-') && v !== 'global', 'this name is reserved');
const TargetValue = z.union([
  z.string().min(1).max(64),
  z
    .object({
      ra_rad: z.number().min(0).max(TAU),
      dec_rad: z.number().min(-Math.PI / 2).max(Math.PI / 2),
      fov_rad: z.number().min(0.0005).max(0.05),
    })
    .strict(),
]);
const Frequency = z.number().min(0.5e9, 'below 0.5 GHz').max(50e9, 'above 50 GHz');
const Azimuth = z.number().min(0).max(TAU);
const Elevation = z.number().min(0.0873, 'below 5°').max(1.5708, 'above 90°');
/** ms; 0 clears the scheduled scan. */
const ScheduleTs = z.number().int().min(0);

// --------------------------------------------------------------- helpers
/** The scan currently running or paused on a sub-array (null when idle/scheduled). */
export function liveScan(state: RtaState, subarrayId: string): RtaState['scans'][string] | null {
  const a = state.subarrays[subarrayId];
  const own = a?.scanId ? state.scans[a.scanId] : undefined;
  if (own && SCANNING_STATES.has(own.status)) return own;
  for (const s of Object.values(state.scans)) {
    if (s.subarray === subarrayId && SCANNING_STATES.has(s.status)) return s;
  }
  return null;
}

const scanning = (state: RtaState, subarrayId: string) =>
  SCANNING_STATES.has(state.subarrays[subarrayId]?.scanState ?? '') || liveScan(state, subarrayId) !== null;

function dishScanning(state: RtaState, dish: RtaDish | undefined): string | null {
  const scanId = dish?.scan?.scan_id;
  if (scanId && SCANNING_STATES.has(state.scans[scanId]?.status ?? '')) return scanId;
  return null;
}

function geometryOf(view: RtaControlView, a: RtaSubarray | undefined) {
  const t = a?.target ?? null;
  if (!t) return null;
  return typeof t === 'string' ? view.resolveTarget(t) : t;
}

/** Altitude of the sub-array's target right now, or null when it cannot be computed. */
export function targetAltitudeDeg(view: RtaControlView, subarrayId: string): number | null {
  const g = geometryOf(view, view.state.subarrays[subarrayId]);
  const site = view.site();
  const now = view.simNow();
  if (!g || !site || now === null) return null;
  return altitudeDeg(g.ra_rad, g.dec_rad, site.lat, site.lon, now);
}

const block = (code: string, message?: string): GuardBlock => ({
  code,
  message: message ?? explainCommandReason(code) ?? code,
});

const falseClose = (title: string, facts: string[]): ConfirmNeed => ({ title, facts });

// ------------------------------------------------------------- safeguards
/** set_target / set_observation_frequency / request_recalibration: not while scanning. */
function notWhileScanning(view: RtaControlView, subarrayId: string): GuardBlock | null {
  return scanning(view.state, subarrayId) ? block('scanning') : null;
}

function startScanGuard(view: RtaControlView, subarrayId: string): GuardBlock | null {
  const state = view.state;
  if (state.global.windStow === true) return block('wind_stow');
  const a = state.subarrays[subarrayId];
  if (!a) return block('unknown_target');
  const paused = (a.scanState ?? '') === 'paused' || liveScan(state, subarrayId)?.status === 'paused';
  if (paused) return null; // resuming does not need a sky position
  const inService = a.members.filter((id) => state.dishes[id]?.enabled !== false && state.dishes[id]?.stowed !== true).length;
  if (a.members.length > 0 && inService < MIN_SCAN_DISHES) {
    return block('too_few_dishes', `${inService} dish(es) available in ${subarrayId}: a scan needs at least ${MIN_SCAN_DISHES}`);
  }
  if (!a.target) return block('no_target');
  if (typeof a.target === 'string' && !view.hasTarget(a.target)) {
    return block('unknown_target', `The sub-array target "${a.target}" is not in the catalogue`);
  }
  const alt = targetAltitudeDeg(view, subarrayId);
  if (alt !== null && alt < TARGET_MIN_ALT_DEG) {
    return block(
      'target_elevation',
      `The target is at ${alt.toFixed(1)}° elevation; a scan needs at least ${TARGET_MIN_ALT_DEG}° above the horizon`,
    );
  }
  return null;
}

function scheduleScanGuard(view: RtaControlView, subarrayId: string, value: unknown): GuardBlock | null {
  if (scanning(view.state, subarrayId)) return block('scanning');
  const at = typeof value === 'number' ? value : 0;
  if (at === 0) return null;
  const now = view.simNow();
  if (now !== null && at <= now) return block('invalid_value', 'The scheduled time is in the past');
  return null;
}

function pauseScanGuard(view: RtaControlView, subarrayId: string): GuardBlock | null {
  const state = view.state;
  if (liveScan(state, subarrayId)?.status === 'running' || state.subarrays[subarrayId]?.scanState === 'running') return null;
  return block('not_scanning');
}

function cancelScanGuard(view: RtaControlView, subarrayId: string): GuardBlock | null {
  const a = view.state.subarrays[subarrayId];
  if (scanning(view.state, subarrayId) || (a?.nextScan ?? null) !== null) return null;
  return block('not_scanning');
}

function targetGuard(view: RtaControlView, subarrayId: string, value: unknown): GuardBlock | null {
  const scanningBlock = notWhileScanning(view, subarrayId);
  if (scanningBlock) return scanningBlock;
  if (typeof value === 'string' && !view.hasTarget(value)) {
    return block('unknown_target', `"${value}" is not in the ARL target catalogue`);
  }
  return null;
}

function assignSubarrayGuard(view: RtaControlView, dishId: string, value: unknown): GuardBlock | null {
  const state = view.state;
  const scanId = dishScanning(state, state.dishes[dishId]);
  if (scanId) return block('scanning', `This dish is taking part in scan ${scanId}: it cannot change sub-array until the scan ends`);
  const name = typeof value === 'string' ? value : '';
  if (name && !state.subarrays[name] && Object.keys(state.subarrays).length >= MAX_SUBARRAYS) return block('subarray_limit');
  return null;
}

function slewGuard(view: RtaControlView, dishId: string): GuardBlock | null {
  const state = view.state;
  const d = state.dishes[dishId];
  if (d?.stowed === true || state.global.windStow === true) return block('stowed');
  if (dishScanning(state, d)) return block('scanning');
  return null;
}

function stowGuard(view: RtaControlView, dishId: string, value: unknown): GuardBlock | null {
  if (value === false) {
    return view.state.global.windStow === true
      ? block('wind_stow', 'Wind stow is engaged: dishes cannot be released until the gust drops')
      : null;
  }
  return null;
}

/** Disabling or stowing one more dish: refuse at/below the minimum, confirm when it would cross it. */
function dishAvailability(view: RtaControlView, dishId: string): { blocked: GuardBlock | null; confirm: ConfirmNeed | null } {
  const active = view.state.global.activeDishes;
  const minActive = view.minActive();
  if (active === null) return { blocked: null, confirm: null };
  const after = active - 1;
  if (after < minActive) {
    if (active < minActive) {
      return {
        blocked: block(
          'min_active_dishes',
          `Only ${active} dishes are in service (minimum ${minActive}): ${dishId} cannot be taken out until the array recovers`,
        ),
        confirm: null,
      };
    }
    return {
      blocked: null,
      confirm: falseClose(`Take ${dishId} out of service?`, [
        `Dishes in service fall from ${active} to ${after}, below the ${minActive} minimum`,
        'The availability alert will be raised after 60 s',
        `Send the command again to confirm (valid for 60 s)`,
      ]),
    };
  }
  return { blocked: null, confirm: null };
}

// ----------------------------------------------------------------- specs
export function rtaCommandSpecs(view: RtaControlView): CommandSpec[] {
  const specs: CommandSpec[] = [
    {
      control: 'start_scan',
      entityKinds: ['subarray'],
      schema: TrueOnly,
      ui: { label: 'Start scan', kind: 'boolean', help: 'Starts a scan now, or resumes a paused one' },
      guard: ({ entity }) => startScanGuard(view, entity),
    },
    {
      control: 'schedule_scan',
      entityKinds: ['subarray'],
      schema: ScheduleTs,
      ui: {
        label: 'Schedule scan',
        kind: 'timestamp',
        unit: 'ms',
        help: 'Start a scan at this simulated time (0 clears it)',
      },
      guard: ({ entity, value }) => scheduleScanGuard(view, entity, value),
    },
    {
      control: 'pause_scan',
      entityKinds: ['subarray'],
      schema: TrueOnly,
      ui: { label: 'Pause scan', kind: 'boolean', help: 'Pauses the running scan; dishes keep reporting' },
      guard: ({ entity }) => pauseScanGuard(view, entity),
    },
    {
      control: 'cancel_scan',
      entityKinds: ['subarray'],
      schema: TrueOnly,
      ui: { label: 'Cancel scan', kind: 'boolean', danger: true, help: 'Cancels a running, paused or scheduled scan' },
      guard: ({ entity }) => cancelScanGuard(view, entity),
    },
    {
      control: 'set_target',
      entityKinds: ['subarray'],
      schema: TargetValue,
      ui: { label: 'Set target', kind: 'target', help: 'Catalogue id or {ra_rad, dec_rad, fov_rad}' },
      guard: ({ entity, value }) => targetGuard(view, entity, value),
    },
    {
      control: 'set_observation_frequency',
      entityKinds: ['subarray'],
      schema: Frequency,
      ui: {
        label: 'Observation frequency',
        kind: 'number',
        min: 0.5,
        max: 50,
        unit: 'GHz',
        scale: 1e9,
        help: 'Band the sub-array observes (0.5 to 50 GHz)',
      },
      guard: ({ entity }) => notWhileScanning(view, entity),
    },
    {
      control: 'assign_subarray',
      entityKinds: ['dish'],
      schema: SubarrayName,
      ui: { label: 'Assign sub-array', kind: 'text', help: 'Move the dish to a sub-array (a new name creates one, max 4)' },
      guard: ({ entity, value }) => assignSubarrayGuard(view, entity, value),
    },
    {
      control: 'adjust_azimuth',
      entityKinds: ['dish'],
      schema: Azimuth,
      ui: { label: 'Slew azimuth', kind: 'number', min: 0, max: 360, unit: '°', scale: Math.PI / 180, help: 'From north, 0 to 360°' },
      guard: ({ entity }) => slewGuard(view, entity),
    },
    {
      control: 'adjust_elevation',
      entityKinds: ['dish'],
      schema: Elevation,
      ui: { label: 'Slew elevation', kind: 'number', min: 5, max: 90, unit: '°', scale: Math.PI / 180, help: '5° to 90°' },
      guard: ({ entity }) => slewGuard(view, entity),
    },
    {
      control: 'enable_dish',
      entityKinds: ['dish'],
      schema: z.boolean(),
      ui: { label: 'Enable dish', kind: 'boolean', mayConfirm: true, help: 'Take the dish in or out of service' },
      guard: ({ entity, value }) => (value === false ? dishAvailability(view, entity).blocked : null),
      confirm: ({ entity, value }) => (value === false ? dishAvailability(view, entity).confirm : null),
    },
    {
      control: 'stow_dish',
      entityKinds: ['dish'],
      schema: z.boolean(),
      ui: { label: 'Stow dish', kind: 'boolean', danger: true, mayConfirm: true, help: 'true points it straight up; false releases it' },
      guard: ({ entity, value }) => (value === true ? dishAvailability(view, entity).blocked : stowGuard(view, entity, value)),
      confirm: ({ entity, value }) => (value === true ? dishAvailability(view, entity).confirm : null),
    },
    {
      control: 'request_recalibration',
      entityKinds: ['dish'],
      schema: TrueOnly,
      ui: { label: 'Request recalibration', kind: 'boolean', help: 'Resets the system temperature drift (2 min)' },
      guard: ({ entity }) => {
        const scanId = dishScanning(view.state, view.state.dishes[entity]);
        return scanId ? block('scanning', `This dish is taking part in scan ${scanId}`) : null;
      },
    },
  ];
  return specs;
}

/** Static presets: each one is a band change on main followed by a scan start. */
export function rtaPresets(): PresetSpec[] {
  const band = (id: string, name: string, hz: number, description: string): PresetSpec => ({
    id,
    name,
    description,
    steps: [
      { entity: 'main', control: 'set_observation_frequency', value: hz },
      { entity: 'main', control: 'start_scan', value: true },
    ],
  });
  return [
    band('rta-observe-l', 'Observe at L band', 1.42e9, 'Sets main to 1.42 GHz and starts a scan of its current target'),
    band('rta-observe-c', 'Observe at C band', 5e9, 'Sets main to 5 GHz and starts a scan of its current target'),
    band('rta-observe-k', 'Observe at K band', 22e9, 'Sets main to 22 GHz and starts a scan of its current target'),
    {
      id: 'rta-stop',
      name: 'Stop scanning',
      description: 'Cancels whatever main is scanning or has scheduled',
      steps: [{ entity: 'main', control: 'cancel_scan', value: true }],
    },
  ];
}
