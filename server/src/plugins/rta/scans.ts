// RTA scan persistence: typed sample rows, scan records and stored images (per scan, raw + clean).
import { buildCleanImage, buildRawImage, emptyColumns, type CleanOptions, type ScanImage } from '../../../../shared/scan-image.js';
import type { ScanSampleColumns, ScanStatus, ScanTarget } from '../../../../shared/types.js';
import type { Db } from '../../db/index.js';
import type { RtaScan } from './model.js';
import type { ScanSample } from './parse.js';

export type ImageMode = 'raw' | 'clean';

export function insertSamples(db: Db, samples: ScanSample[]): void {
  if (!samples.length) return;
  const st = db.prepare(`INSERT OR IGNORE INTO rta_scan_samples
    (scan_id, dish, sim_ts, dra, ddec, signal, snr_db, band_hz, fault_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of samples) st.run(s.scanId, s.dish, s.ts, s.dra, s.ddec, s.signal, s.snr, s.bandHz, s.fault);
}

export function upsertScan(db: Db, s: RtaScan): void {
  db.prepare(
    `INSERT INTO rta_scans (scan_id, subarray, target_json, target_id, ra_rad, dec_rad, fov_rad, band_hz, grid_size,
      overlap, dishes_json, expected_duration_s, origin, started_ts, ended_ts, status, reason, events_json, geometry_from_event)
     VALUES (@scanId, @subarray, @targetJson, @targetId, @raRad, @decRad, @fovRad, @bandHz, @gridSize, @overlap,
      @dishesJson, @expectedDurationS, @origin, @startedTs, @endedTs, @status, @reason, @eventsJson, @geom)
     ON CONFLICT (scan_id) DO UPDATE SET subarray = excluded.subarray, target_json = excluded.target_json,
      target_id = excluded.target_id, ra_rad = excluded.ra_rad, dec_rad = excluded.dec_rad, fov_rad = excluded.fov_rad,
      band_hz = excluded.band_hz, grid_size = excluded.grid_size, overlap = excluded.overlap,
      dishes_json = excluded.dishes_json, expected_duration_s = excluded.expected_duration_s, origin = excluded.origin,
      started_ts = excluded.started_ts, ended_ts = excluded.ended_ts, status = excluded.status, reason = excluded.reason,
      events_json = excluded.events_json, geometry_from_event = excluded.geometry_from_event`,
  ).run({
    scanId: s.scanId,
    subarray: s.subarray,
    targetJson: JSON.stringify(s.target),
    targetId: s.targetId,
    raRad: s.raRad,
    decRad: s.decRad,
    fovRad: s.fovRad,
    bandHz: s.bandHz,
    gridSize: s.gridSize,
    overlap: s.overlap,
    dishesJson: JSON.stringify(s.dishes),
    expectedDurationS: s.expectedDurationS,
    origin: s.origin,
    startedTs: s.startedTs,
    endedTs: s.endedTs,
    status: s.status,
    reason: s.reason,
    eventsJson: JSON.stringify(s.events),
    geom: s.geometryFromEvent ? 1 : 0,
  });
}

interface ScanRow {
  scan_id: string;
  subarray: string;
  target_json: string | null;
  target_id: string | null;
  ra_rad: number | null;
  dec_rad: number | null;
  fov_rad: number;
  band_hz: number | null;
  grid_size: number;
  overlap: number;
  dishes_json: string;
  expected_duration_s: number | null;
  origin: string | null;
  started_ts: number | null;
  ended_ts: number | null;
  status: string;
  reason: string | null;
  events_json: string;
  geometry_from_event: number;
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function loadScans(db: Db, limit = 200): { scan: RtaScan; samples: number }[] {
  const rows = db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM rta_scan_samples x WHERE x.scan_id = s.scan_id) AS n
       FROM rta_scans s ORDER BY started_ts DESC LIMIT ?`,
    )
    .all(limit) as (ScanRow & { n: number })[];
  return rows.map((r) => ({
    samples: r.n,
    scan: {
      scanId: r.scan_id,
      subarray: r.subarray,
      target: parseJson<ScanTarget>(r.target_json, null),
      targetId: r.target_id,
      raRad: r.ra_rad,
      decRad: r.dec_rad,
      fovRad: r.fov_rad,
      bandHz: r.band_hz,
      gridSize: r.grid_size,
      overlap: r.overlap,
      dishes: parseJson<string[]>(r.dishes_json, []),
      expectedDurationS: r.expected_duration_s,
      origin: r.origin,
      startedTs: r.started_ts,
      endedTs: r.ended_ts,
      status: r.status as ScanStatus,
      reason: r.reason,
      events: parseJson(r.events_json, []),
      samples: r.n,
      progress: {},
      lastSampleTs: null,
      geometryFromEvent: r.geometry_from_event === 1,
    },
  }));
}

export function loadSampleColumns(db: Db, scanId: string, sinceTs = -Infinity): ScanSampleColumns {
  const rows = db
    .prepare(
      `SELECT dish, sim_ts, dra, ddec, signal, snr_db, fault_code FROM rta_scan_samples
       WHERE scan_id = ? AND sim_ts > ? ORDER BY sim_ts`,
    )
    .raw()
    .all(scanId, Number.isFinite(sinceTs) ? sinceTs : -1) as [string, number, number, number, number, number | null, string | null][];
  const cols = emptyColumns();
  const index = new Map<string, number>();
  for (const [dish, ts, dra, ddec, sig, snr, f] of rows) {
    let i = index.get(dish);
    if (i === undefined) {
      i = cols.dishes.push(dish) - 1;
      index.set(dish, i);
    }
    cols.d.push(i);
    cols.t.push(ts);
    cols.ra.push(dra);
    cols.dec.push(ddec);
    cols.s.push(sig);
    cols.snr.push(snr);
    cols.f.push(f);
  }
  return cols;
}

export function buildImage(cols: ScanSampleColumns, scan: Pick<RtaScan, 'gridSize' | 'fovRad'>, mode: ImageMode, opts: Partial<CleanOptions>): ScanImage {
  const geom = { gridSize: scan.gridSize, fovRad: scan.fovRad };
  return mode === 'raw' ? buildRawImage(cols, geom) : buildCleanImage(cols, geom, opts);
}

export function storeImage(db: Db, scanId: string, mode: ImageMode, img: ScanImage, minSnrDb: number | null): void {
  db.prepare(
    `INSERT INTO scan_images (scan_id, mode, n, pixels, holes, filled, stats_json, min_snr_db, created_wall_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (scan_id, mode) DO UPDATE SET n = excluded.n, pixels = excluded.pixels, holes = excluded.holes,
       filled = excluded.filled, stats_json = excluded.stats_json, min_snr_db = excluded.min_snr_db,
       created_wall_ts = excluded.created_wall_ts`,
  ).run(
    scanId,
    mode,
    img.n,
    Buffer.from(img.values.buffer, img.values.byteOffset, img.values.byteLength),
    Buffer.from(img.holes),
    Buffer.from(img.filled),
    JSON.stringify(img.stats),
    minSnrDb,
    Date.now(),
  );
}

export function loadImage(db: Db, scanId: string, mode: ImageMode): (ScanImage & { minSnrDb: number | null }) | null {
  const r = db.prepare(`SELECT * FROM scan_images WHERE scan_id = ? AND mode = ?`).get(scanId, mode) as
    | { n: number; pixels: Buffer; holes: Buffer; filled: Buffer; stats_json: string; min_snr_db: number | null }
    | undefined;
  if (!r) return null;
  const values = new Float32Array(r.n * r.n);
  new Uint8Array(values.buffer).set(r.pixels.subarray(0, values.byteLength));
  return {
    n: r.n,
    values,
    holes: new Uint8Array(r.holes),
    filled: new Uint8Array(r.filled),
    counts: new Uint16Array(r.n * r.n),
    stats: parseJson(r.stats_json, {} as ScanImage['stats']),
    minSnrDb: r.min_snr_db,
  };
}

export function hasImage(db: Db, scanId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM scan_images WHERE scan_id = ? LIMIT 1`).get(scanId);
}

/** JSON-friendly image: values rounded, NaN → null. */
export function imageToJson(img: ScanImage, mode: ImageMode) {
  const values: (number | null)[] = new Array(img.values.length);
  for (let i = 0; i < img.values.length; i++) {
    const v = img.values[i]!;
    values[i] = Number.isNaN(v) ? null : Math.round(v * 10000) / 10000;
  }
  const holes: number[] = [];
  const filled: number[] = [];
  for (let i = 0; i < img.holes.length; i++) {
    if (img.holes[i]) holes.push(i);
    if (img.filled[i]) filled.push(i);
  }
  return { n: img.n, mode, values, holes, filled, stats: img.stats };
}
