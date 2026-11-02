// Replay engine shared types + tunables. Replay is read-only: it folds our own raw_messages (never the ARL
// API backlog) through the same parse + reducer code the live path uses, so a seek to sim time t shows
// exactly the state the platform had at t.
import type { AlertDTO, AlertSummaryDTO, KpiDTO, ServiceTopology } from '../../../shared/types.js';
import type { ServiceState } from '../core/state-store.js';

/** Playback speeds the UI may request (× real time; at a 100 ms tick, 60 = one sim minute per wall second). */
export const SPEEDS = [0.5, 1, 2, 4, 8, 16, 60] as const;
export type Speed = (typeof SPEEDS)[number];

export const MAX_SESSIONS = 10;
export const IDLE_MS = 30 * 60_000; // a session untouched for 30 min is reaped
export const TICK_MS = 100; // play tick; t advances TICK_MS × speed each tick
export const CHUNK = 5_000; // raw_messages rows per fold iteration
export const SNAPSHOT_EVERY_MS = 60_000; // store a plugin snapshot every 60 s of sim time
export const PUSH_MIN_MS = 250; // ≤ 4 SSE updates/s per session
export const MARKER_CAP = 2_000;
export const REPLAY_HEADER = 'x-replay-session';
export const REPLAY_PREFIX = 'replay:';
/** Control routes locked out while a replay session header is present (read-only replay). */
export const CONTROL_PREFIXES = ['/api/commands', '/api/presets', '/api/schedules'] as const;

/** Public session shape (exactly the fields the spec names). */
export interface ReplaySession {
  id: string;
  t: number;
  speed: Speed;
  playing: boolean;
  from: number;
  to: number;
  createdAt: number;
}

export interface ReplayRange {
  min: number | null;
  max: number | null;
}
export interface ReplayRangeDTO {
  overall: ReplayRange;
  services: Record<string, ReplayRange>;
}

export type ReplayMarkerKind = 'alert' | 'command' | 'scan_start' | 'scan_end';
export interface ReplayMarker {
  ts: number;
  kind: ReplayMarkerKind;
  service: string;
  // alert markers
  alertId?: string;
  action?: string;
  severity?: string;
  actor?: string | null;
  // command markers
  commandId?: string;
  control?: string;
  researcher?: string;
  outcome?: string;
  // scan markers
  scanId?: string;
}
export interface ReplayMarkersDTO {
  from: number;
  to: number;
  markers: ReplayMarker[];
  truncated: boolean;
}

export interface ServiceReplayState {
  /** The plugin's own view (same shape its SSE channel / REST endpoint returns), or null when it has none. */
  view: unknown | null;
  /** Generic per-entity retained state + latest telemetry (same shape as /api/services/:svc/state). */
  state: ServiceState;
  topology: ServiceTopology | null;
  kpis: KpiDTO[];
}

export interface ReplayStateDTO {
  id: string;
  t: number;
  from: number;
  to: number;
  speed: Speed;
  playing: boolean;
  services: Record<string, ServiceReplayState>;
  alerts: { alerts: AlertDTO[]; summary: AlertSummaryDTO };
}
