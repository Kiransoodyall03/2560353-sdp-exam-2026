// RTA plugin: typed parse, reducer-backed state, scan sample persistence, image pipeline, SSE + REST.
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_CLEAN } from '../../../../shared/scan-image.js';
import type { DishDTO, ServiceTopology } from '../../../../shared/types.js';
import type { AlertLimit, Target } from '../../arl-api/client.js';
import type { Parsed } from '../../core/parse.js';
import type { Db } from '../../db/index.js';
import type { CommandSpec, PresetSpec } from '../../commands/types.js';
import type { Plugin, PlatformContext, StreamExpectation } from '../types.js';
import { rtaCommandSpecs, rtaPresets, type RtaControlView } from './controls.js';
import {
  dishAlertIndex,
  dishDTO,
  globalDTO,
  limitsFrom,
  powerOutliers,
  scanSummary,
  subarrayDTO,
  targetIdOf,
  type RtaLimits,
} from './dto.js';
import { emptyRtaState, newDelta, reduceRta, type RtaDelta, type RtaScan, type RtaState } from './model.js';
import { parseRta, toScanSample, type ScanFields, type ScanSample } from './parse.js';
import {
  buildImage,
  hasImage,
  imageToJson,
  insertSamples,
  loadImage,
  loadSampleColumns,
  loadScans,
  storeImage,
  upsertScan,
  type ImageMode,
} from './scans.js';

/** SSE tuple for one live scan sample: [dish, ts, dra, ddec, signal, snr, fault]. */
export type ScanSampleTuple = [string, number, number, number, number, number | null, string | null];

const REFERENCE_DIR = new URL('../../../../docs/reference/rta/', import.meta.url);
const REFERENCE_RE = /^tgt-[a-z]{3}-[LCK]\.png$/;
const ScanIdParam = z.object({ id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) });
const DishIdParam = z.object({ id: z.string().regex(/^dish-\d{3}$/) });
const HoursQuery = z.object({ hours: z.coerce.number().min(0.05).max(24 * 14).default(6) });

export class RtaPlugin implements Plugin {
  readonly id = 'rta' as const;
  state: RtaState = emptyRtaState();
  private ctx!: PlatformContext;
  private pending: RtaDelta = newDelta();
  private dirtyRecords = new Set<string>();
  private images = new Set<string>();
  private dishCache = new Map<string, DishDTO>();
  private timer: NodeJS.Timeout | null = null;
  private lastFull = 0;
  private specs: CommandSpec[] | null = null;

  // ------------------------------------------------------------ controls
  /** What the safeguards see: live state plus the catalogue, limits and site geometry. */
  private readonly controlView: RtaControlView = {
    state: this.state,
    simNow: () => this.simNow(),
    resolveTarget: (id) => this.resolve(id),
    hasTarget: (id) => this.catalogue().some((t) => t.id === id),
    site: () => this.site(),
    minActive: () => this.limits().minActive,
  };

  get commands(): CommandSpec[] {
    return (this.specs ??= rtaCommandSpecs(this.controlView));
  }

  get presets(): PresetSpec[] {
    return rtaPresets();
  }

  parse(topic: string, payload: Buffer, recvTs: number, retained: boolean): Parsed[] {
    return parseRta(topic, payload, recvTs, retained);
  }

  init(ctx: PlatformContext): void {
    this.ctx = ctx;
    for (const { scan } of loadScans(ctx.db, 50)) {
      this.state.scans[scan.scanId] = scan;
      if (hasImage(ctx.db, scan.scanId)) this.images.add(scan.scanId);
    }
    ctx.sse.register('rta', () => this.snapshot());
    ctx.sse.registerPrefix('scan:', (channel) => this.scanSnapshot(channel.slice('scan:'.length)));
    this.timer = setInterval(() => this.flushViews(), 250);
    this.timer.unref?.();
  }

  // ------------------------------------------------------------ helpers
  limits(): RtaLimits {
    return limitsFrom(this.ctx?.api.peek<AlertLimit[]>('limits|rta') ?? null);
  }
  private catalogue(): Target[] {
    return this.ctx?.api.peek<Target[]>('targets') ?? [];
  }
  /** Mean dish position from $topology; the target-elevation safeguard uses it. */
  site(): { lat: number; lon: number } | null {
    let lat = 0;
    let lon = 0;
    let n = 0;
    for (const d of Object.values(this.state.dishes)) {
      if (typeof d.lat === 'number' && typeof d.lon === 'number') {
        lat += d.lat;
        lon += d.lon;
        n++;
      }
    }
    return n > 0 ? { lat: lat / n, lon: lon / n } : null;
  }
  private targetName = (id: string) => this.catalogue().find((t) => t.id === id)?.name ?? null;
  private catalogueId = (t: RtaState['subarrays'][string]['target']) => targetIdOf(t, this.catalogue());
  private resolve = (id: string) => {
    const t = this.catalogue().find((x) => x.id === id);
    return t ? { ra_rad: t.ra_rad, dec_rad: t.dec_rad, fov_rad: t.fov_rad } : null;
  };
  private simNow(): number | null {
    return this.ctx?.clock.now('rta') ?? null;
  }
  private maxGustMs(): number | null {
    let max: number | null = null;
    for (const e of Object.values(this.ctx.state.service('lwm').entities)) {
      const g = e.telemetry['weather']?.fields['wind_gust_ms'];
      if (typeof g === 'number' && (max === null || g > max)) max = g;
    }
    return max;
  }

  // ------------------------------------------------------------ fold
  onTopology(_t: ServiceTopology): void {
    /* entity geometry is folded in derive() so replay sees it too */
  }

  derive(p: Parsed): void {
    const d = newDelta();
    reduceRta(this.state, p, d, this.resolve);
    for (const k of d.dishes) this.pending.dishes.add(k);
    for (const k of d.subarrays) this.pending.subarrays.add(k);
    for (const k of d.removedSubarrays) this.pending.removedSubarrays.add(k);
    for (const k of d.scans) this.pending.scans.add(k);
    if (d.global) this.pending.global = true;
    if (p.kind === 'event' && p.event === 'scan') for (const k of d.scans) this.dirtyRecords.add(k);
    for (const k of d.endedScans) {
      this.dirtyRecords.add(k);
      setImmediate(() => this.finishScan(k));
    }
    for (const s of d.samples) {
      const scan = this.state.scans[s.scanId];
      if (scan && scan.samples === 1) this.dirtyRecords.add(s.scanId); // first sample of a scan we never saw start
      const tuple: ScanSampleTuple = [s.dish, s.ts, s.dra, s.ddec, s.signal, s.snr, s.fault];
      this.ctx.sse.append(`scan:${s.scanId}`, [tuple]);
    }
  }

  persist(batch: Parsed[], db: Db): void {
    const samples: ScanSample[] = [];
    for (const p of batch) {
      if (p.kind !== 'telemetry' || p.stream !== 'scan') continue;
      const s = toScanSample(p.entity, p.simTs, p.fields as ScanFields);
      if (s) samples.push(s);
    }
    insertSamples(db, samples);
    for (const id of this.dirtyRecords) {
      const s = this.state.scans[id];
      if (s) upsertScan(db, s);
    }
    this.dirtyRecords.clear();
  }

  expectations(entity: { id: string; kind: string }): StreamExpectation | null {
    if (entity.kind !== 'dish') return null;
    const d = this.state.dishes[entity.id];
    const scanId = d?.lastStream === 'scan' ? d.scan?.scan_id : null;
    const scan = scanId ? this.state.scans[scanId] : undefined;
    const scanning = !!scan && (scan.status === 'running' || scan.status === 'paused');
    const normal = this.ctx.topology.stream('rta', entity.id, 'normal')?.periodS ?? 120;
    const scanP = this.ctx.topology.stream('rta', entity.id, 'scan')?.periodS ?? 1;
    // disabled dishes still report on the normal stream (status false), so every dish is expected
    return { streams: ['normal', 'scan'], periodS: scanning ? scanP : normal };
  }

  kpis() {
    const l = this.limits();
    const active = this.state.global.activeDishes;
    const running = Object.values(this.state.subarrays).filter((a) => a.scanState === 'running').length;
    const stowed = Object.values(this.state.dishes).filter((d) => d.stowed === true).length;
    return [
      {
        label: 'Dishes in service',
        value: active === null ? null : `${active} / ${l.minActive}`,
        status: active === null ? undefined : active < l.minActive ? ('bad' as const) : ('ok' as const),
      },
      {
        label: 'Wind stow',
        value: this.state.global.windStow === null ? null : this.state.global.windStow ? 'ENGAGED' : 'off',
        status: this.state.global.windStow ? ('warn' as const) : ('ok' as const),
      },
      { label: 'Scanning sub-arrays', value: running },
      { label: 'Stowed dishes', value: stowed, status: stowed ? ('warn' as const) : ('ok' as const) },
    ];
  }

  snapshot(): unknown {
    const dishes = this.allDishDTOs();
    const byId = new Map(dishes.map((d) => [d.id, d]));
    const now = this.simNow();
    return {
      dishes,
      subarrays: Object.values(this.state.subarrays).map((a) =>
        subarrayDTO(this.state, a, byId, now, this.targetName, this.catalogueId),
      ),
      global: globalDTO(this.state, dishes, this.limits(), this.maxGustMs()),
      scans: this.scanList(30),
    };
  }

  restore(snapshot: unknown): void {
    // mutate in place: the control safeguards hold a reference to `state`
    Object.assign(this.state, structuredClone(snapshot as RtaState));
  }

  // ------------------------------------------------------------ views
  private allDishDTOs(): DishDTO[] {
    const limits = this.limits();
    const alerts = dishAlertIndex(this.ctx.alerts.openForService('rta'));
    const dishes = Object.values(this.state.dishes);
    const outliers = powerOutliers(dishes);
    const now = this.simNow();
    const list = dishes
      .map((d) => dishDTO(this.state, d, limits, alerts.get(d.id), outliers, now))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const d of list) this.dishCache.set(d.id, d);
    return list;
  }

  private scanSummaryOf(s: RtaScan) {
    const sum = scanSummary(s, this.simNow(), this.targetName, this.images.has(s.scanId));
    if (!sum.targetId) {
      const id = this.catalogueId(s.target);
      if (id) {
        sum.targetId = id;
        sum.targetName = this.targetName(id);
      }
    }
    return sum;
  }

  scanList(limit = 200) {
    return Object.values(this.state.scans)
      .sort((a, b) => (b.startedTs ?? 0) - (a.startedTs ?? 0))
      .slice(0, limit)
      .map((s) => this.scanSummaryOf(s));
  }

  private flushViews(): void {
    const sse = this.ctx.sse;
    const p = this.pending;
    this.pending = newDelta();
    const full = Date.now() - this.lastFull > 5000; // statuses also age with time and alerts
    if (!sse.hasSubscribers('rta')) {
      if (full) this.lastFull = Date.now();
      return;
    }
    if (full || p.dishes.size || p.subarrays.size || p.global) {
      const before = new Map(this.dishCache);
      const dishes = this.allDishDTOs();
      for (const d of dishes) {
        const prev = before.get(d.id);
        if (p.dishes.has(d.id) || !prev || prev.status !== d.status || prev.alertCount !== d.alertCount || full) {
          sse.patch('rta', `dish:${d.id}`, d);
        }
      }
      const byId = new Map(dishes.map((d) => [d.id, d]));
      const now = this.simNow();
      for (const a of Object.values(this.state.subarrays)) {
        if (full || p.subarrays.has(a.id) || p.dishes.size) {
          sse.patch('rta', `subarray:${a.id}`, subarrayDTO(this.state, a, byId, now, this.targetName, this.catalogueId));
        }
      }
      sse.patch('rta', 'global', globalDTO(this.state, dishes, this.limits(), this.maxGustMs()));
    }
    for (const id of p.removedSubarrays) sse.patch('rta', `subarray:${id}`, null);
    for (const id of p.scans) {
      const s = this.state.scans[id];
      if (!s) continue;
      const sum = this.scanSummaryOf(s);
      sse.patch('rta', `scan:${id}`, sum);
      sse.patch(`scan:${id}`, 'scan', sum);
    }
    if (full) this.lastFull = Date.now();
  }

  private scanSnapshot(scanId: string) {
    const s = this.state.scans[scanId];
    if (!s) return { scan: null, samples: null };
    this.ctx.flush();
    return { scan: this.scanSummaryOf(s), samples: loadSampleColumns(this.ctx.db, scanId) };
  }

  /** Builds and stores raw + clean images once a scan has ended. */
  finishScan(scanId: string): void {
    const s = this.state.scans[scanId];
    if (!s) return;
    try {
      this.ctx.flush();
      const cols = loadSampleColumns(this.ctx.db, scanId);
      if (cols.s.length === 0) return;
      const minSnrDb = this.limits().minSnrDb;
      storeImage(this.ctx.db, scanId, 'raw', buildImage(cols, s, 'raw', {}), null);
      storeImage(this.ctx.db, scanId, 'clean', buildImage(cols, s, 'clean', { minSnrDb }), minSnrDb);
      this.images.add(scanId);
      this.pending.scans.add(scanId);
      this.ctx.log.info({ scanId, samples: cols.s.length }, 'scan image stored');
    } catch (err) {
      this.ctx.log.error({ err, scanId }, 'scan image build failed');
    }
  }

  // ------------------------------------------------------------ REST
  routes(app: FastifyInstance): void {
    const db = this.ctx.db;
    app.get('/api/rta', async () => this.snapshot());

    app.get('/api/rta/dishes/:id', async (req, reply) => {
      const { id } = DishIdParam.parse(req.params);
      const d = this.state.dishes[id];
      if (!d) return reply.code(404).send({ error: 'not_found', detail: 'dish' });
      this.allDishDTOs();
      return { dish: this.dishCache.get(id) ?? null, topology: this.ctx.topology.entity('rta', id) };
    });

    app.get('/api/rta/dishes/:id/history', async (req) => {
      const { id } = DishIdParam.parse(req.params);
      const { hours } = HoursQuery.parse(req.query);
      const to = this.simNow() ?? Date.now();
      const from = to - hours * 3600e3;
      const rows = db
        .prepare(
          `SELECT sim_ts, stream, json FROM telemetry WHERE service = 'rta' AND entity = ? AND sim_ts >= ? ORDER BY sim_ts`,
        )
        .all(id, from) as { sim_ts: number; stream: string; json: string }[];
      const stride = Math.max(1, Math.ceil(rows.length / 1500));
      const keys = ['temperature_k', 'power_w', 'system_temperature_k', 'elevation_rad', 'azimuth_rad', 'snr_db'] as const;
      const out: Record<string, (number | null)[]> & { ts: number[]; stream: string[] } = { ts: [], stream: [] } as never;
      for (const k of keys) out[k] = [];
      for (let i = 0; i < rows.length; i += stride) {
        const r = rows[i]!;
        const f = JSON.parse(r.json) as Record<string, unknown>;
        out.ts.push(r.sim_ts);
        out.stream.push(r.stream);
        for (const k of keys) out[k]!.push(typeof f[k] === 'number' ? (f[k] as number) : null);
      }
      const irr = db
        .prepare(
          `SELECT bucket_ts, AVG(avg) AS v FROM aggregates WHERE service = 'lwm' AND metric = 'irradiance_wm2'
           AND bucket_ts >= ? GROUP BY bucket_ts ORDER BY bucket_ts`,
        )
        .all(from) as { bucket_ts: number; v: number }[];
      const states = db
        .prepare(
          `SELECT item, sim_ts, value_json FROM state_history WHERE service = 'rta' AND entity = ? AND sim_ts >= ?
           ORDER BY sim_ts`,
        )
        .all(id, from) as { item: string; sim_ts: number; value_json: string | null }[];
      return {
        dish: id,
        from,
        to,
        series: out,
        irradiance: { ts: irr.map((r) => r.bucket_ts), wm2: irr.map((r) => Math.round(r.v)) },
        states: states.map((s) => ({ item: s.item, ts: s.sim_ts, value: s.value_json === null ? null : JSON.parse(s.value_json) })),
      };
    });

    app.get('/api/rta/trend', async (req) => {
      const { hours } = HoursQuery.parse(req.query);
      const to = this.simNow() ?? Date.now();
      const from = to - hours * 3600e3;
      const active = db
        .prepare(
          `SELECT sim_ts, value_json FROM state_history WHERE service = 'rta' AND entity = 'global' AND item = 'active_dishes'
           AND sim_ts >= ? ORDER BY sim_ts`,
        )
        .all(from) as { sim_ts: number; value_json: string }[];
      const gust = db
        .prepare(
          `SELECT bucket_ts, MAX(max) AS v FROM aggregates WHERE service = 'lwm' AND metric = 'wind_gust_ms'
           AND bucket_ts >= ? GROUP BY bucket_ts ORDER BY bucket_ts`,
        )
        .all(from) as { bucket_ts: number; v: number }[];
      const temp = db
        .prepare(
          `SELECT bucket_ts, AVG(avg) AS v, MAX(max) AS hi FROM aggregates WHERE service = 'rta' AND metric = 'temperature_k'
           AND bucket_ts >= ? GROUP BY bucket_ts ORDER BY bucket_ts`,
        )
        .all(from) as { bucket_ts: number; v: number; hi: number }[];
      const irr = db
        .prepare(
          `SELECT bucket_ts, AVG(avg) AS v FROM aggregates WHERE service = 'lwm' AND metric = 'irradiance_wm2'
           AND bucket_ts >= ? GROUP BY bucket_ts ORDER BY bucket_ts`,
        )
        .all(from) as { bucket_ts: number; v: number }[];
      // stowed dish count over time: sweep state_history from each dish's last value before the window
      const stowedRows = db
        .prepare(
          `SELECT entity, sim_ts, value_json FROM state_history WHERE service = 'rta' AND item = 'stowed' AND sim_ts <= ?
           ORDER BY sim_ts`,
        )
        .all(to) as { entity: string; sim_ts: number; value_json: string | null }[];
      const cur = new Map<string, boolean>();
      const stowed: { ts: number[]; count: number[] } = { ts: [], count: [] };
      const count = () => [...cur.values()].filter(Boolean).length;
      let started = false;
      for (const r of stowedRows) {
        if (r.sim_ts >= from && !started) {
          stowed.ts.push(from);
          stowed.count.push(count());
          started = true;
        }
        cur.set(r.entity, r.value_json === 'true');
        if (r.sim_ts >= from) {
          stowed.ts.push(r.sim_ts);
          stowed.count.push(count());
        }
      }
      stowed.ts.push(to);
      stowed.count.push(count());
      return {
        from,
        to,
        minActive: this.limits().minActive,
        windStowGustMs: this.limits().windStowGustMs,
        active: { ts: active.map((r) => r.sim_ts), value: active.map((r) => Number(JSON.parse(r.value_json))) },
        gust: { ts: gust.map((r) => r.bucket_ts), value: gust.map((r) => r.v) },
        stowed,
        temperature: { ts: temp.map((r) => r.bucket_ts), mean: temp.map((r) => r.v), max: temp.map((r) => r.hi) },
        irradiance: { ts: irr.map((r) => r.bucket_ts), value: irr.map((r) => r.v) },
      };
    });

    app.get('/api/rta/scans', async () => this.scanList(200));

    app.get('/api/rta/scans/:id', async (req, reply) => {
      const { id } = ScanIdParam.parse(req.params);
      const s = this.state.scans[id];
      if (!s) return reply.code(404).send({ error: 'not_found', detail: 'scan' });
      return { ...this.scanSummaryOf(s), events: s.events };
    });

    app.get('/api/rta/scans/:id/samples', async (req, reply) => {
      const { id } = ScanIdParam.parse(req.params);
      if (!this.state.scans[id]) return reply.code(404).send({ error: 'not_found', detail: 'scan' });
      this.ctx.flush();
      return loadSampleColumns(db, id);
    });

    const ImageQuery = z.object({
      mode: z.enum(['raw', 'clean']).default('clean'),
      minSnr: z.coerce.number().min(-50).max(50).optional(),
      fill: z.enum(['0', '1']).default('1'),
    });
    app.get('/api/rta/scans/:id/image', async (req, reply) => {
      const { id } = ScanIdParam.parse(req.params);
      const q = ImageQuery.parse(req.query);
      const s = this.state.scans[id];
      if (!s) return reply.code(404).send({ error: 'not_found', detail: 'scan' });
      const mode = q.mode as ImageMode;
      const ended = s.status !== 'running' && s.status !== 'paused';
      const defaults = q.minSnr === undefined && q.fill === '1';
      if (ended && defaults) {
        const stored = loadImage(db, id, mode);
        if (stored) return { ...imageToJson(stored, mode), stored: true, minSnrDb: stored.minSnrDb };
      }
      this.ctx.flush();
      const cols = loadSampleColumns(db, id);
      const minSnrDb = q.minSnr ?? this.limits().minSnrDb;
      const img = buildImage(cols, s, mode, { ...DEFAULT_CLEAN, minSnrDb, fillHoles: q.fill === '1' });
      return { ...imageToJson(img, mode), stored: false, minSnrDb: mode === 'clean' ? minSnrDb : null };
    });

    app.get('/api/reference/rta/:file', async (req, reply) => {
      const { file } = z.object({ file: z.string() }).parse(req.params);
      if (!REFERENCE_RE.test(file)) return reply.code(404).send({ error: 'not_found', detail: 'reference image' });
      try {
        const buf = await readFile(new URL(file, REFERENCE_DIR));
        return reply.type('image/png').header('cache-control', 'public, max-age=3600').send(buf);
      } catch {
        return reply.code(404).send({ error: 'not_found', detail: 'no reference image for this target/band' });
      }
    });
  }
}

export function createRtaPlugin(): RtaPlugin {
  return new RtaPlugin();
}
