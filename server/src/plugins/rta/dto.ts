// RTA view models: dish status, sub-array health, scan summaries. Pure functions over RtaState.
import { bandOf, median } from '../../../../shared/scan-image.js';
import type {
  AlertDTO,
  DishDTO,
  DishStatus,
  RtaGlobalDTO,
  ScanSummaryDTO,
  SubarrayDTO,
} from '../../../../shared/types.js';
import { SEVERITY_RANK } from '../../../../shared/types.js';
import { scanEtaS, scanProgress, type RtaDish, type RtaScan, type RtaState, type RtaSubarray } from './model.js';

export interface RtaLimits {
  minActive: number;
  tempWarnK: number;
  tempCritK: number;
  powerMaxW: number;
  calibrationMaxAgeH: number;
  minSnrDb: number;
  windStowGustMs: number;
}

export const DEFAULT_LIMITS: RtaLimits = {
  minActive: 80,
  tempWarnK: 333,
  tempCritK: 343,
  powerMaxW: 5000,
  calibrationMaxAgeH: 168,
  minSnrDb: 3,
  windStowGustMs: 15,
};

/** Maps /v1/alert-limits/rta keys onto RtaLimits (defaults from the API spec when absent). */
export function limitsFrom(list: { key: string; value: number }[] | null): RtaLimits {
  const m = new Map((list ?? []).map((l) => [l.key, l.value]));
  const g = (k: string, d: number) => m.get(k) ?? d;
  return {
    minActive: g('availability.min_active', DEFAULT_LIMITS.minActive),
    tempWarnK: g('dish_temperature.warn_k', DEFAULT_LIMITS.tempWarnK),
    tempCritK: g('dish_temperature.crit_k', DEFAULT_LIMITS.tempCritK),
    powerMaxW: g('dish_power.max_w', DEFAULT_LIMITS.powerMaxW),
    calibrationMaxAgeH: g('calibration.max_age_h', DEFAULT_LIMITS.calibrationMaxAgeH),
    minSnrDb: g('scan.min_snr_db', DEFAULT_LIMITS.minSnrDb),
    windStowGustMs: g('wind_stow.gust_ms', DEFAULT_LIMITS.windStowGustMs),
  };
}

export interface DishAlertInfo {
  count: number;
  maxSeverity: AlertDTO['severity'] | null;
  types: Set<string>;
}

export function dishAlertIndex(open: AlertDTO[]): Map<string, DishAlertInfo> {
  const m = new Map<string, DishAlertInfo>();
  for (const a of open) {
    if (a.service !== 'rta' || a.svcState !== 'raised' || !a.entity?.startsWith('dish-')) continue;
    let i = m.get(a.entity);
    if (!i) m.set(a.entity, (i = { count: 0, maxSeverity: null, types: new Set() }));
    i.count++;
    i.types.add(a.type);
    if (!i.maxSeverity || SEVERITY_RANK[a.severity] > SEVERITY_RANK[i.maxSeverity]) i.maxSeverity = a.severity;
  }
  return m;
}

const NORMAL_PERIOD_MS = 120_000;
const SERVICE_FAULTS = new Set(['drive_stall', 'overheat', 'receiver_fault', 'power_fault']);

/** Robust power outliers: |p − median| > 3.5 × 1.4826 × MAD among dishes with a reading. */
export function powerOutliers(dishes: RtaDish[]): Set<string> {
  const vals = dishes
    .map((d) => [d.id, (d.lastStream === 'scan' ? d.scan?.power_w : d.normal?.power_w) ?? null] as const)
    .filter((x): x is readonly [string, number] => typeof x[1] === 'number');
  const out = new Set<string>();
  if (vals.length < 8) return out;
  const med = median(vals.map((v) => v[1]));
  const mad = median(vals.map((v) => Math.abs(v[1] - med)));
  const scale = Math.max(1.4826 * mad, 50);
  for (const [id, p] of vals) if (Math.abs(p - med) / scale > 3.5) out.add(id);
  return out;
}

function activeScanFor(state: RtaState, d: RtaDish): RtaScan | null {
  const id = d.scan?.scan_id;
  if (!id) return null;
  const s = state.scans[id];
  return s && (s.status === 'running' || s.status === 'paused') ? s : null;
}

export function dishStatus(
  state: RtaState,
  d: RtaDish,
  limits: RtaLimits,
  alerts: DishAlertInfo | undefined,
  simNow: number | null,
): { status: DishStatus; reason: string } {
  const latest = d.lastStream === 'scan' ? d.scan : d.normal;
  const fault = latest?.fault_code ?? null;
  const silent = simNow !== null && d.lastTs !== null && simNow - d.lastTs > 3 * NORMAL_PERIOD_MS;
  if (alerts?.types.has('dish_offline') || fault === 'comms_loss' || silent) {
    return { status: 'offline', reason: silent ? 'No telemetry for > 3 periods' : 'Dish offline' };
  }
  if (d.enabled === false) return { status: 'disabled', reason: 'Disabled (maintenance)' };
  if (fault && SERVICE_FAULTS.has(fault)) return { status: 'fault', reason: `Fault: ${fault}` };
  if (d.stowed === true) return { status: 'stowed', reason: state.global.windStow ? 'Stowed (wind stow)' : 'Stowed' };
  const temp = latest?.temperature_k ?? null;
  if (temp !== null && temp > limits.tempWarnK) return { status: 'warning', reason: `Hot: ${temp.toFixed(1)} K` };
  if (fault === 'encoder_error') return { status: 'warning', reason: 'Encoder error (still in service)' };
  if (alerts && alerts.maxSeverity && alerts.maxSeverity !== 'info' && !alerts.types.has('dish_scan')) {
    return { status: 'warning', reason: [...alerts.types].join(', ') };
  }
  const scan = activeScanFor(state, d);
  if (scan && d.lastStream === 'scan') return { status: 'scanning', reason: `Scanning ${scan.scanId}` };
  if (latest?.status === true) return { status: 'ok', reason: 'In service' };
  if (latest?.status === false) return { status: 'fault', reason: 'Not in service' };
  return { status: 'unknown', reason: 'No telemetry yet' };
}

export function dishDTO(
  state: RtaState,
  d: RtaDish,
  limits: RtaLimits,
  alerts: DishAlertInfo | undefined,
  outliers: Set<string>,
  simNow: number | null,
): DishDTO {
  const latest = d.lastStream === 'scan' ? d.scan : d.normal;
  const { status, reason } = dishStatus(state, d, limits, alerts, simNow);
  const scan = activeScanFor(state, d);
  return {
    id: d.id,
    row: d.row,
    col: d.col,
    lat: d.lat,
    lon: d.lon,
    status,
    statusReason: reason,
    subarray: d.subarray,
    enabled: d.enabled,
    stowed: d.stowed,
    inService: latest?.status ?? null,
    faultCode: latest?.fault_code ?? null,
    temperatureK: latest?.temperature_k ?? null,
    elevationRad: latest?.elevation_rad ?? null,
    azimuthRad: latest?.azimuth_rad ?? null,
    powerW: latest?.power_w ?? null,
    systemTemperatureK: latest?.system_temperature_k ?? null,
    commanded: d.commanded,
    lastCalibration: d.lastCalibration,
    calibrationAgeH:
      d.lastCalibration !== null && simNow !== null ? Math.round(((simNow - d.lastCalibration) / 3600e3) * 10) / 10 : null,
    lastTs: d.lastTs,
    lastStream: d.lastStream,
    scanId: scan?.scanId ?? null,
    scanProgress: scan ? (d.scan?.scan_progress ?? null) : null,
    meanSnrDb: d.snr && d.snr.n ? Math.round((d.snr.sum / d.snr.n) * 100) / 100 : null,
    powerOutlier: outliers.has(d.id),
    alertCount: alerts?.count ?? 0,
  };
}

export function scanSummary(
  s: RtaScan,
  simNow: number | null,
  targetName: (id: string) => string | null,
  hasImage: boolean,
): ScanSummaryDTO {
  const expected = s.gridSize * s.gridSize * s.overlap;
  return {
    scanId: s.scanId,
    subarray: s.subarray,
    target: s.target,
    targetId: s.targetId,
    targetName: s.targetId ? targetName(s.targetId) : null,
    raRad: s.raRad,
    decRad: s.decRad,
    fovRad: s.fovRad,
    bandHz: s.bandHz,
    band: bandOf(s.bandHz),
    gridSize: s.gridSize,
    overlap: s.overlap,
    dishes: s.dishes,
    expectedDurationS: s.expectedDurationS,
    origin: s.origin,
    startedTs: s.startedTs,
    endedTs: s.endedTs,
    status: s.status,
    reason: s.reason,
    samples: s.samples,
    coverage: expected > 0 ? Math.min(1, s.samples / expected) : 0,
    progress: scanProgress(s),
    etaS: scanEtaS(s, simNow),
    hasImage,
    geometryFromEvent: s.geometryFromEvent,
  };
}

/** Catalogue id of a sub-array target, matching custom positions to the catalogue when they coincide. */
export function targetIdOf(
  t: RtaSubarray['target'],
  catalogue: { id: string; ra_rad: number; dec_rad: number; fov_rad: number }[],
): string | null {
  if (typeof t === 'string') return t;
  if (!t) return null;
  const hit = catalogue.find(
    (c) => Math.abs(c.ra_rad - t.ra_rad) < 1e-4 && Math.abs(c.dec_rad - t.dec_rad) < 1e-4 && Math.abs(c.fov_rad - t.fov_rad) < 1e-6,
  );
  return hit?.id ?? null;
}

export function subarrayDTO(
  state: RtaState,
  a: RtaSubarray,
  dishes: Map<string, DishDTO>,
  simNow: number | null,
  targetName: (id: string) => string | null,
  catalogueId: (t: RtaSubarray['target']) => string | null,
): SubarrayDTO {
  const health = { members: a.members.length, inService: 0, fault: 0, stowed: 0, disabled: 0, offline: 0 };
  for (const id of a.members) {
    const d = dishes.get(id);
    if (!d) continue;
    if (d.inService) health.inService++;
    if (d.status === 'fault') health.fault++;
    if (d.status === 'stowed') health.stowed++;
    if (d.status === 'disabled') health.disabled++;
    if (d.status === 'offline') health.offline++;
  }
  const scan = a.scanId ? state.scans[a.scanId] : undefined;
  const live = scan && (scan.status === 'running' || scan.status === 'paused') ? scan : undefined;
  const tid = catalogueId(a.target);
  return {
    id: a.id,
    members: a.members,
    scanState: a.scanState,
    target: a.target,
    targetName: tid ? targetName(tid) : null,
    observationFrequency: a.observationFrequency,
    band: bandOf(a.observationFrequency),
    nextScan: a.nextScan,
    scanId: a.scanId,
    progress: live ? scanProgress(live) : null,
    etaS: live ? scanEtaS(live, simNow) : null,
    health,
  };
}

export function globalDTO(state: RtaState, dishes: DishDTO[], limits: RtaLimits, maxGustMs: number | null): RtaGlobalDTO {
  return {
    activeDishes: state.global.activeDishes,
    minActive: limits.minActive,
    windStow: state.global.windStow,
    windStowSinceTs: state.global.windStowSinceTs,
    stowedCount: dishes.filter((d) => d.stowed === true).length,
    maxGustMs,
    minSnrDb: limits.minSnrDb,
  };
}
