// DTOs shared by the server API and the web client. Types only (plus tiny constants), no runtime deps.

export const SERVICES = ['rta', 'lwm', 'opg'] as const;
export type ServiceId = (typeof SERVICES)[number];
export const ALL_ARL_SERVICES = ['rta', 'mhe', 'lwm', 'opg', 'owt'] as const;
export type ArlServiceCode = (typeof ALL_ARL_SERVICES)[number];

export type AlertService = ServiceId | 'platform';
export type Severity = 'info' | 'warning' | 'critical';
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
export type SvcState = 'raised' | 'cleared';
export type OpState = 'unacked' | 'acked' | 'resolved';

export function isServiceId(s: string): s is ServiceId {
  return (SERVICES as readonly string[]).includes(s);
}

// ---------- topology ----------
export interface TopologyEntity {
  id: string;
  kind: string;
  row?: number;
  col?: number;
  lat?: number;
  lon?: number;
}
export interface TopologyField {
  key: string;
  type: string;
  unit?: string;
  values?: string[];
}
export interface TopologyStream {
  topic: string;
  name: string;
  entityKinds: string[];
  periodS: number | null;
  fields: TopologyField[];
}
export interface TopologyStateItem {
  topic: string;
  item: string;
  type: string;
  unit?: string;
}
export interface TopologyControl {
  topic: string;
  control: string;
  entityKinds: string[];
  value: Record<string, unknown>;
}
export interface ServiceTopology {
  service: string;
  version: string;
  entities: TopologyEntity[];
  streams: TopologyStream[];
  state: TopologyStateItem[];
  events: string[];
  controls: TopologyControl[];
}

// ---------- health ----------
export interface SilentStream {
  entity: string;
  stream: string;
  lastTs: number | null;
  periodS: number;
}
export interface ServiceHealthDTO {
  service: ServiceId;
  online: boolean | null;
  onlineSinceTs: number | null;
  lastSeenSimTs: number | null;
  lastSeenWallTs: number | null;
  simNow: number | null;
  speedup: number | null;
  topologyVersion: string | null;
  entityCount: number;
  messages: number;
  silent: SilentStream[];
  seqGaps: { total: number; outstanding: number; lastGapWallTs: number | null };
  activeAlertIds: number;
}
export interface PlatformHealthDTO {
  wallTs: number;
  broker: { connected: boolean; sinceWallTs: number | null; reconnects: number; error: string | null };
  api: { reachable: boolean | null; status: string | null; lastCheckWallTs: number | null; error: string | null };
  ingestion: {
    degraded: boolean;
    queueDepth: number;
    written: number;
    dropped: number;
    rawOnly: number;
    lastFlushMs: number | null;
    msgPerSec: number;
  };
  services: ServiceHealthDTO[];
}

export interface KpiDTO {
  label: string;
  value: string | number | null;
  unit?: string;
  status?: 'ok' | 'warn' | 'bad';
}
export interface ServiceOverviewDTO {
  health: ServiceHealthDTO;
  kpis: KpiDTO[];
  alerts: { unacked: number; open: number };
}
export interface OverviewDTO {
  platform: PlatformHealthDTO;
  services: ServiceOverviewDTO[];
  alerts: AlertSummaryDTO;
}

// ---------- alerts ----------
export interface AlertDTO {
  key: string; // `${service}:${alertId}`
  service: AlertService;
  alertId: string;
  type: string;
  severity: Severity;
  maxSeverity: Severity;
  entity: string | null;
  svcState: SvcState;
  opState: OpState;
  raisedTs: number | null;
  clearedTs: number | null;
  value: number | null;
  limit: number | null;
  unit: string | null;
  message: string;
  metadata: Record<string, unknown>;
  placeholder: boolean;
  ackTs: number | null;
  ackBy: string | null;
  ackName: string | null;
  ackNote: string | null;
  resolvedTs: number | null;
  resolvedBy: string | null;
  resolvedName: string | null;
  resolutionNote: string | null;
  updatedWallTs: number;
}
export interface AlertEventDTO {
  id: number;
  service: AlertService;
  alertId: string;
  simTs: number | null;
  wallTs: number;
  action: string;
  actor: string | null;
  detail: Record<string, unknown>;
}
export interface AlertSummaryDTO {
  unacked: Record<Severity, number>;
  open: number;
  raised: number;
  byService: Record<string, { unacked: number; open: number }>;
}
export interface AlertDetailDTO {
  alert: AlertDTO;
  events: AlertEventDTO[];
  commands: CommandDTO[];
  suggestion: string;
}

export interface CommandDTO {
  commandId: string;
  service: ServiceId;
  entity: string;
  control: string;
  value: unknown;
  researcher: string;
  requestedTs: number;
  state: string;
  progress: number | null;
  reason: string | null;
  detail: string | null;
  updatedTs: number;
}

// ---------- researchers ----------
export type VerifyFailReason = 'unknown' | 'defunct' | 'not_permitted' | 'api_unavailable' | 'rate_limited' | 'invalid';
export interface VerifyResponse {
  valid: boolean;
  reason: VerifyFailReason | null;
  name: string | null;
  service: AlertService;
  retryAfterS?: number;
}

// ---------- SSE ----------
export type SseType = 'snapshot' | 'patch' | 'append';
export interface SseEnvelope<T = unknown> {
  type: SseType;
  channel: string;
  simTs: number | null;
  data: T;
}

// ---------- RTA ----------
export type DishStatus = 'ok' | 'scanning' | 'stowed' | 'disabled' | 'fault' | 'warning' | 'offline' | 'unknown';
export interface DishDTO {
  id: string;
  row: number;
  col: number;
  lat: number | null;
  lon: number | null;
  status: DishStatus;
  statusReason: string;
  subarray: string | null;
  enabled: boolean | null;
  stowed: boolean | null;
  inService: boolean | null;
  faultCode: string | null;
  temperatureK: number | null;
  elevationRad: number | null;
  azimuthRad: number | null;
  powerW: number | null;
  systemTemperatureK: number | null;
  commanded: { azimuth_rad: number; elevation_rad: number } | null;
  lastCalibration: number | null;
  calibrationAgeH: number | null;
  lastTs: number | null;
  lastStream: string | null;
  scanId: string | null;
  scanProgress: number | null;
  meanSnrDb: number | null;
  powerOutlier: boolean;
  alertCount: number;
}
export type ScanTarget = string | { ra_rad: number; dec_rad: number; fov_rad: number } | null;
export interface SubarrayDTO {
  id: string;
  members: string[];
  scanState: string | null;
  target: ScanTarget;
  targetName: string | null;
  observationFrequency: number | null;
  band: Band | null;
  nextScan: number | null;
  scanId: string | null;
  progress: number | null;
  etaS: number | null;
  health: { members: number; inService: number; fault: number; stowed: number; disabled: number; offline: number };
}
export type Band = 'L' | 'C' | 'K';
export interface RtaGlobalDTO {
  activeDishes: number | null;
  minActive: number;
  windStow: boolean | null;
  windStowSinceTs: number | null;
  stowedCount: number;
  maxGustMs: number | null;
  minSnrDb: number;
}
export type ScanStatus = 'running' | 'paused' | 'completed' | 'cancelled' | 'failed' | 'unknown';
export interface ScanSummaryDTO {
  scanId: string;
  subarray: string;
  target: ScanTarget;
  targetId: string | null;
  targetName: string | null;
  raRad: number | null;
  decRad: number | null;
  fovRad: number;
  bandHz: number | null;
  band: Band | null;
  gridSize: number;
  overlap: number;
  dishes: string[];
  expectedDurationS: number | null;
  origin: string | null;
  startedTs: number | null;
  endedTs: number | null;
  status: ScanStatus;
  reason: string | null;
  samples: number;
  coverage: number; // 0..1 of N*N*overlap
  progress: number | null;
  etaS: number | null;
  hasImage: boolean;
  geometryFromEvent: boolean;
}
/** Columnar sample batch for one scan (compact on the wire). */
export interface ScanSampleColumns {
  dishes: string[]; // dish id table
  d: number[]; // index into dishes
  t: number[]; // sim ts
  ra: number[]; // pointing_offset_ra_rad
  dec: number[]; // pointing_offset_dec_rad
  s: number[]; // signal_strength
  snr: (number | null)[];
  f: (string | null)[]; // fault_code
}
