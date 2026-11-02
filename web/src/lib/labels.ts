// Display words for the alert vocabulary. The wire values stay lower case and snake_case; the screen
// shows sentence case, so every surface that prints one of these states goes through these maps.
import type { AlertService, Severity } from '../../../shared/types';

export const SERVICE_TEXT: Record<AlertService, string> = {
  rta: 'Radio telescope',
  lwm: 'Weather',
  opg: 'Power',
  platform: 'Platform',
};

export const SEVERITY_TEXT: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

export const OP_TEXT: Record<string, string> = {
  unacked: 'Unacknowledged',
  acked: 'Acknowledged',
  resolved: 'Resolved',
};

export const SVC_TEXT: Record<string, string> = {
  raised: 'Raised',
  cleared: 'Cleared',
};

export const SCAN_STATUS_TEXT: Record<string, string> = {
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  unknown: 'Unknown',
};
