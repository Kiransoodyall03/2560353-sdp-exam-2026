// Command DTOs + plain-language reason mapping shared by the server API and the web client.
// (shared/types.ts stays types-only; this file holds the small runtime lookups both sides need.)
import type { CommandDTO, ServiceId } from './types';

export type CommandUiKind = 'boolean' | 'enum' | 'number' | 'target' | 'timestamp' | 'text';

export interface CommandUi {
  label: string;
  kind: CommandUiKind;
  /** For `enum`: the allowed values with their labels. */
  options?: { value: string | number; label: string }[];
  min?: number;
  max?: number;
  unit?: string;
  /** Display value × scale = the value on the wire (GHz → Hz, degrees → radians). */
  scale?: number;
  help?: string;
  /** Marked red in the UI (stops, disables, stows). */
  danger?: boolean;
  /** The server may answer 428 confirm_required for some values. */
  mayConfirm?: boolean;
  /** Show the control for these entities only (e.g. `main`). */
  entities?: string[];
}

export interface CommandSpecDTO {
  service: ServiceId;
  control: string;
  entityKinds: string[];
  ui: CommandUi;
}

/** 428 confirm_required body: facts to show and the one-shot token to replay in the request. */
export interface CommandConfirmDTO {
  title: string;
  facts: string[];
  token: string;
  expiresAtTs: number;
}

export interface PresetStepDTO {
  entity: string;
  control: string;
  value: unknown;
}

export interface PresetDTO {
  id: string;
  service: ServiceId;
  name: string;
  description: string;
  steps: PresetStepDTO[];
}

export interface ScheduleDTO {
  id: number;
  service: ServiceId;
  name: string;
  presetId: string | null;
  steps: PresetStepDTO[];
  atSimTs: number;
  researcher: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  detail: string | null;
  createdWallTs: number;
}

export interface CommandResultDTO {
  command: CommandDTO;
}

/** Plain-language text for every ack reason the services (and our safeguards) can produce. */
const REASON_TEXT: Record<string, string> = {
  controls_disabled: 'Controls are disabled on the live broker',
  malformed: 'The controller rejected the command as malformed',
  unknown_control: 'The controller does not know this control',
  unknown_target: 'The controller does not know this entity',
  unknown_researcher: 'The controller does not know this researcher',
  researcher_defunct: 'This researcher is no longer active',
  researcher_not_permitted: 'This researcher is not permitted to control this service',
  api_unavailable: 'The ARL API was unreachable when the controller checked the researcher',
  invalid_value: 'The value is not valid for this control',
  precondition_failed: 'The controller refused: a precondition is not met',
  busy: 'The target is already running a long command',
  fault: 'The equipment reported a fault',
  timeout: 'No acknowledgement arrived within 30 s',
  interrupted: 'The control was interrupted (service restart or broker loss)',
  start_failed: 'The generator start failed',
  low_fuel: 'Fuel is below 2 %: the generators cannot be started',
  calibration_failed: 'The calibration failed',
  limit_reached: 'The limit for this control has been reached',
  // platform safeguards
  scanning: 'The target is scanning: stop or pause it first',
  wind_stow: 'Wind stow is engaged: the array is parked until the gust drops',
  stowed: 'The dish is stowed: release it before slewing',
  target_elevation: 'The target is below 15° above the horizon',
  no_target: 'No target is set on this sub-array',
  too_few_dishes: 'Fewer than 3 dishes in service: a scan cannot start',
  subarray_limit: 'The array already has 4 sub-arrays',
  not_scanning: 'The sub-array is not scanning',
  already_running: 'The generators are already starting or running',
  not_running: 'The generators are not running',
  min_active_dishes: 'This would drop the dishes in service below the 80 minimum',
  solar_disabled_in_daylight: 'Disabling the solar array in daylight leaves the load to the batteries',
  // LWM safeguards
  lightning_proximity: 'Lightning is close: technician visits cannot start until the Lightning Proximity alert clears',
  not_needed: 'The pan is already above 195 mm: a refill is not needed',
  sensor_disturbed: 'The gust is above the High Wind warning limit: a recalibration would be disturbed',
  backfill_in_progress: 'The site is replaying buffered samples: recalibration must wait until it catches up',
};

/** Maps an ack/guard reason to plain language; unknown codes are shown as-is (never hidden). */
export function explainCommandReason(
  reason: string | null | undefined,
  ctx: { service?: string; control?: string } = {},
): string | null {
  if (!reason) return null;
  if (reason === 'researcher_not_permitted') {
    return `This researcher is not permitted to control ${(ctx.service ?? 'this service').toUpperCase()}`;
  }
  const known = REASON_TEXT[reason];
  if (known) return known;
  return reason.replace(/_/g, ' ');
}
