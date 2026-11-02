// RTA plugin state + deterministic reducer (live and replay fold the same code). No I/O here.
import type { ScanStatus, ScanTarget } from '../../../../shared/types.js';
import type { Parsed } from '../../core/parse.js';
import type { NormalFields, ScanEvent, ScanFields, ScanSample } from './parse.js';
import { toScanSample } from './parse.js';

export interface RtaDish {
  id: string;
  row: number;
  col: number;
  lat: number | null;
  lon: number | null;
  normal: (NormalFields & { ts: number }) | null;
  scan: (ScanFields & { ts: number }) | null;
  lastTs: number | null;
  lastStream: 'normal' | 'scan' | null;
  commanded: { azimuth_rad: number; elevation_rad: number } | null;
  subarray: string | null;
  lastCalibration: number | null;
  enabled: boolean | null;
  stowed: boolean | null;
  snr: { scanId: string; sum: number; n: number } | null;
}

export interface RtaSubarray {
  id: string;
  members: string[];
  scanState: string | null;
  target: ScanTarget;
  observationFrequency: number | null;
  nextScan: number | null;
  scanId: string | null;
  updatedTs: number | null;
}

export interface RtaScan {
  scanId: string;
  subarray: string;
  target: ScanTarget;
  targetId: string | null;
  raRad: number | null;
  decRad: number | null;
  fovRad: number;
  bandHz: number | null;
  gridSize: number;
  overlap: number;
  dishes: string[];
  expectedDurationS: number | null;
  origin: string | null;
  startedTs: number | null;
  endedTs: number | null;
  status: ScanStatus;
  reason: string | null;
  events: { ts: number; event: string; reason: string | null }[];
  samples: number;
  progress: Record<string, number>; // latest scan_progress per dish
  lastSampleTs: number | null;
  geometryFromEvent: boolean;
}

export interface RtaState {
  dishes: Record<string, RtaDish>;
  subarrays: Record<string, RtaSubarray>;
  scans: Record<string, RtaScan>;
  global: { activeDishes: number | null; windStow: boolean | null; windStowSinceTs: number | null };
}

export interface RtaDelta {
  dishes: Set<string>;
  subarrays: Set<string>;
  removedSubarrays: Set<string>;
  scans: Set<string>;
  endedScans: Set<string>;
  global: boolean;
  samples: ScanSample[];
}

export const newDelta = (): RtaDelta => ({
  dishes: new Set(),
  subarrays: new Set(),
  removedSubarrays: new Set(),
  scans: new Set(),
  endedScans: new Set(),
  global: false,
  samples: [],
});

export const emptyRtaState = (): RtaState => ({
  dishes: {},
  subarrays: {},
  scans: {},
  global: { activeDishes: null, windStow: null, windStowSinceTs: null },
});

export const DEFAULT_GRID = 128; // spec: scan_grid_size default
export const DEFAULT_OVERLAP = 3; // spec: scan_overlap default
const MAX_SCANS_IN_MEMORY = 200;

/** Resolves a catalogue id to its geometry (used when we missed a scan's started event). */
export type TargetResolver = (id: string) => { ra_rad: number; dec_rad: number; fov_rad: number } | null;

function dish(s: RtaState, id: string): RtaDish {
  let d = s.dishes[id];
  if (!d) {
    const m = /^dish-(\d+)$/.exec(id);
    const idx = m ? Number(m[1]) - 1 : 0;
    s.dishes[id] = d = {
      id,
      row: Math.floor(idx / 10),
      col: idx % 10,
      lat: null,
      lon: null,
      normal: null,
      scan: null,
      lastTs: null,
      lastStream: null,
      commanded: null,
      subarray: null,
      lastCalibration: null,
      enabled: null,
      stowed: null,
      snr: null,
    };
  }
  return d;
}

function subarray(s: RtaState, id: string): RtaSubarray {
  let a = s.subarrays[id];
  if (!a) {
    s.subarrays[id] = a = {
      id,
      members: [],
      scanState: null,
      target: null,
      observationFrequency: null,
      nextScan: null,
      scanId: null,
      updatedTs: null,
    };
  }
  return a;
}

const END_EVENTS: Record<string, ScanStatus> = { completed: 'completed', cancelled: 'cancelled', failed: 'failed' };

function geometryFor(target: ScanTarget, resolve: TargetResolver | undefined) {
  if (target && typeof target === 'object') return target;
  if (typeof target === 'string' && resolve) return resolve(target);
  return null;
}

function newScan(scanId: string, subarrayId: string, target: ScanTarget, resolve?: TargetResolver): RtaScan {
  const g = geometryFor(target, resolve);
  return {
    scanId,
    subarray: subarrayId,
    target,
    targetId: typeof target === 'string' ? target : null,
    raRad: g?.ra_rad ?? null,
    decRad: g?.dec_rad ?? null,
    fovRad: g?.fov_rad ?? 0.01,
    bandHz: null,
    gridSize: DEFAULT_GRID,
    overlap: DEFAULT_OVERLAP,
    dishes: [],
    expectedDurationS: null,
    origin: null,
    startedTs: null,
    endedTs: null,
    status: 'running',
    reason: null,
    events: [],
    samples: 0,
    progress: {},
    lastSampleTs: null,
    geometryFromEvent: false,
  };
}

function pruneScans(s: RtaState) {
  const ids = Object.keys(s.scans);
  if (ids.length <= MAX_SCANS_IN_MEMORY) return;
  const ended = ids
    .map((id) => s.scans[id]!)
    .filter((x) => x.status !== 'running' && x.status !== 'paused')
    .sort((a, b) => (a.startedTs ?? 0) - (b.startedTs ?? 0));
  for (const x of ended.slice(0, ids.length - MAX_SCANS_IN_MEMORY)) delete s.scans[x.scanId];
}

export function reduceRta(s: RtaState, p: Parsed, delta: RtaDelta, resolve?: TargetResolver): void {
  if (p.kind === 'topology') {
    for (const e of p.topology.entities) {
      if (e.kind === 'dish') {
        const d = dish(s, e.id);
        if (e.row !== undefined) d.row = e.row;
        if (e.col !== undefined) d.col = e.col;
        d.lat = e.lat ?? d.lat;
        d.lon = e.lon ?? d.lon;
        delta.dishes.add(e.id);
      } else if (e.kind === 'subarray') {
        subarray(s, e.id);
        delta.subarrays.add(e.id);
      }
    }
    // sub-arrays that disappeared from $topology
    const listed = new Set(p.topology.entities.filter((e) => e.kind === 'subarray').map((e) => e.id));
    for (const id of Object.keys(s.subarrays)) {
      if (!listed.has(id) && id !== 'main') {
        delete s.subarrays[id];
        delta.removedSubarrays.add(id);
      }
    }
    return;
  }

  if (p.kind === 'telemetry') {
    if (!/^dish-/.test(p.entity) || p.backfill) return;
    const d = dish(s, p.entity);
    if (p.stream === 'normal') {
      d.normal = { ...(p.fields as NormalFields), ts: p.simTs };
      d.lastStream = 'normal';
    } else if (p.stream === 'scan') {
      const f = p.fields as ScanFields;
      d.scan = { ...f, ts: p.simTs };
      d.lastStream = 'scan';
      if (f.scan_id) {
        let scan = s.scans[f.scan_id];
        if (!scan) {
          const sa = d.subarray ?? 'main';
          scan = s.scans[f.scan_id] = newScan(f.scan_id, sa, s.subarrays[sa]?.target ?? null, resolve);
          scan.startedTs = p.simTs;
          pruneScans(s);
        }
        if (f.band_hz != null && scan.bandHz === null) scan.bandHz = f.band_hz;
        if (f.scan_progress != null) scan.progress[p.entity] = f.scan_progress;
        const sample = toScanSample(p.entity, p.simTs, f);
        if (sample) {
          scan.samples++;
          scan.lastSampleTs = p.simTs;
          delta.samples.push(sample);
          if (sample.snr !== null) {
            if (!d.snr || d.snr.scanId !== sample.scanId) d.snr = { scanId: sample.scanId, sum: 0, n: 0 };
            d.snr.sum += sample.snr;
            d.snr.n++;
          }
        }
        delta.scans.add(f.scan_id);
      }
    } else return;
    if (d.lastTs === null || p.simTs >= d.lastTs) d.lastTs = p.simTs;
    delta.dishes.add(p.entity);
    return;
  }

  if (p.kind === 'state') {
    const v = p.value;
    if (p.entity === 'global') {
      if (p.item === 'active_dishes') s.global.activeDishes = typeof v === 'number' ? v : null;
      else if (p.item === 'wind_stow') {
        const on = v === true;
        if (on && s.global.windStow !== true) s.global.windStowSinceTs = p.simTs;
        if (!on) s.global.windStowSinceTs = null;
        s.global.windStow = typeof v === 'boolean' ? v : null;
      } else return;
      delta.global = true;
      return;
    }
    if (/^dish-/.test(p.entity)) {
      const d = dish(s, p.entity);
      switch (p.item) {
        case 'commanded':
          d.commanded = (v as RtaDish['commanded']) ?? null;
          break;
        case 'subarray':
          d.subarray = typeof v === 'string' ? v : null;
          break;
        case 'last_calibration':
          d.lastCalibration = typeof v === 'number' ? v : null;
          break;
        case 'enabled':
          d.enabled = typeof v === 'boolean' ? v : null;
          break;
        case 'stowed':
          d.stowed = typeof v === 'boolean' ? v : null;
          break;
        default:
          return;
      }
      delta.dishes.add(p.entity);
      return;
    }
    // sub-array state; an empty retained payload means the sub-array was removed
    if (p.removed) {
      const a = s.subarrays[p.entity];
      if (!a) return;
      if (p.item === 'members') {
        delete s.subarrays[p.entity];
        delta.removedSubarrays.add(p.entity);
      }
      return;
    }
    const a = subarray(s, p.entity);
    a.updatedTs = p.simTs;
    switch (p.item) {
      case 'members':
        a.members = Array.isArray(v) ? (v as string[]) : [];
        break;
      case 'scan_state': {
        a.scanState = typeof v === 'string' ? v : null;
        const sc = a.scanId ? s.scans[a.scanId] : undefined;
        if (sc && (sc.status === 'running' || sc.status === 'paused')) {
          if (a.scanState === 'complete' || a.scanState === 'cancelled' || a.scanState === 'idle') {
            // we missed the end event (e.g. platform restarted mid-scan)
            sc.status = a.scanState === 'complete' ? 'completed' : a.scanState === 'cancelled' ? 'cancelled' : 'unknown';
            sc.endedTs = p.simTs;
            delta.scans.add(sc.scanId);
            delta.endedScans.add(sc.scanId);
          }
        }
        break;
      }
      case 'target':
        a.target = (v as ScanTarget) ?? null;
        break;
      case 'observation_frequency':
        a.observationFrequency = typeof v === 'number' ? v : null;
        break;
      case 'next_scan':
        a.nextScan = typeof v === 'number' && v > 0 ? v : null;
        break;
      case 'scan_id':
        a.scanId = typeof v === 'string' ? v : null;
        break;
      default:
        return;
    }
    delta.subarrays.add(p.entity);
    return;
  }

  if (p.kind === 'event' && p.event === 'scan') {
    const e = p.body as unknown as ScanEvent;
    const sa = e.entity ?? p.entity;
    let scan = s.scans[e.scan_id];
    if (e.event === 'started') {
      const target = (e.target ?? null) as ScanTarget;
      const geom = geometryFor(target, resolve);
      const saTarget = s.subarrays[sa]?.target;
      scan = s.scans[e.scan_id] = {
        ...(scan ?? newScan(e.scan_id, sa, target, resolve)),
        subarray: sa,
        target,
        // the started event carries the position; the sub-array state keeps the catalogue id
        targetId:
          typeof target === 'string' ? target : typeof saTarget === 'string' ? saTarget : (scan?.targetId ?? null),
        raRad: e.ra_rad ?? geom?.ra_rad ?? null,
        decRad: e.dec_rad ?? geom?.dec_rad ?? null,
        fovRad: e.fov_rad ?? geom?.fov_rad ?? 0.01,
        bandHz: e.band_hz ?? null,
        gridSize: e.grid_size ?? DEFAULT_GRID,
        overlap: e.overlap ?? DEFAULT_OVERLAP,
        dishes: e.dishes ?? [],
        expectedDurationS: e.expected_duration_s ?? null,
        origin: e.origin ?? null,
        startedTs: p.simTs,
        status: 'running',
        geometryFromEvent: e.fov_rad != null,
      };
      pruneScans(s);
    } else if (!scan) {
      scan = s.scans[e.scan_id] = newScan(e.scan_id, sa, s.subarrays[sa]?.target ?? null, resolve);
    }
    scan.events.push({ ts: p.simTs, event: e.event, reason: e.reason ?? null });
    if (e.event === 'paused') scan.status = 'paused';
    else if (e.event === 'resumed') scan.status = 'running';
    const end = END_EVENTS[e.event];
    if (end) {
      scan.status = end;
      scan.endedTs = p.simTs;
      scan.reason = e.reason ?? null;
      delta.endedScans.add(e.scan_id);
    }
    delta.scans.add(e.scan_id);
  }
}

export function scanProgress(scan: RtaScan): number | null {
  const vals = Object.values(scan.progress);
  if (vals.length === 0) return scan.status === 'completed' ? 1 : null;
  const participants = scan.dishes.length || vals.length;
  return Math.min(1, vals.reduce((a, b) => a + b, 0) / participants);
}

/** ETA in sim seconds from progress so far (null when unknown). */
export function scanEtaS(scan: RtaScan, simNow: number | null): number | null {
  if (scan.status !== 'running' || scan.startedTs === null || simNow === null) return null;
  const p = scanProgress(scan);
  if (p === null || p <= 0.01) return scan.expectedDurationS;
  const elapsed = (simNow - scan.startedTs) / 1000;
  return Math.max(0, Math.round((elapsed / p) * (1 - p)));
}
