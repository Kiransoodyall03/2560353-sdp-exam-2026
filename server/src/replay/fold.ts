// ReplayFold: an isolated re-run of the live ingest pipeline over our own raw_messages, so a seek to sim
// time t reconstructs exactly the state the platform had at t — through the SAME parse + reducer code the
// live path uses (never the ARL API backlog). Isolation matters: folding must not touch the live plugins'
// state, the live SQLite tables, or push anything to live SSE subscribers. Each service is folded on its
// own (per-service state is independent), starting from its nearest stored snapshot and replaying forward.
import type Database from 'better-sqlite3';
import type { ArlApiClient } from '../arl-api/client.js';
import type { AlertStore } from '../alerts/store.js';
import { SimClock } from '../core/clock.js';
import { parseMessage, type Parsed } from '../core/parse.js';
import { SseHub } from '../core/sse.js';
import { StateStore, type ServiceState } from '../core/state-store.js';
import { TopologyRegistry } from '../core/topology.js';
import { Aggregator } from '../db/aggregates.js';
import { openDb, type Db } from '../db/index.js';
import { silentLogger } from '../log.js';
import type { Plugin, PlatformContext } from '../plugins/types.js';
import { ReplayAlertStore } from './alerts.js';
import { CHUNK } from './types.js';

/**
 * A fresh instance of the same plugin class, wired to an isolated context. Returns null for the generic
 * (object-literal) plugin, which has no reducer state of its own — its generic StateStore entries are still
 * folded, there is just no plugin view/kpis to reconstruct.
 */
function isolate(live: Plugin, ctx: PlatformContext): Plugin | null {
  const Ctor = live.constructor as unknown;
  // An object-literal plugin (the generic LWM/OPG stand-in) has constructor === Object and no reducer state
  // of its own to replay; only real classes can be re-instantiated into an isolated copy.
  if (typeof Ctor !== 'function' || Ctor === Object) return null;
  let fresh: Plugin;
  try {
    fresh = new (Ctor as new () => Plugin)();
  } catch {
    return null;
  }
  if (fresh.id !== live.id || typeof fresh.parse !== 'function') return null;
  // The plugin classes keep `ctx` as a TS-private field; at runtime it is a plain own property we can set.
  (fresh as unknown as { ctx: PlatformContext }).ctx = ctx;
  return fresh;
}

interface RawRow {
  id: number;
  sim_ts: number | null;
  recv_ts: number;
  service: string;
  topic: string;
  payload: string;
  retained: number;
}

/** Per-service fold position: `ready` once seeded (snapshot/head), then the last timed row folded. */
interface Cursor {
  ready: boolean;
  sim: number;
  id: number;
}

export class ReplayFold {
  /** Scratch DB the isolated plugins write to (RTA finishScan / persist); kept off the live database. */
  readonly scratch: Db;
  readonly topology = new TopologyRegistry();
  readonly state = new StateStore();
  readonly aggregator = new Aggregator();
  readonly clock = new SimClock(() => 0); // now(svc) === the last sim ts folded for that service
  readonly sse = new SseHub(() => null); // no subscribers, so patch/append are no-ops
  readonly alertStore = new ReplayAlertStore();
  readonly ctx: PlatformContext;
  private readonly iso = new Map<string, Plugin>();
  private readonly cursor = new Map<string, Cursor>();
  private readonly headStmt: Database.Statement;
  private readonly timedStmt: Database.Statement;
  private readonly snapStmt: Database.Statement;
  private closed = false;

  constructor(
    private readonly source: Db, // the live DB: raw_messages + state_snapshots, read-only here
    private readonly live: Map<string, Plugin>,
    liveApi: ArlApiClient,
  ) {
    this.scratch = openDb(':memory:');
    this.ctx = {
      db: this.scratch,
      topology: this.topology,
      state: this.state,
      clock: this.clock,
      sse: this.sse,
      api: liveApi,
      alerts: this.alertStore as unknown as AlertStore,
      aggregator: this.aggregator,
      log: silentLogger,
      flush: () => {},
    };
    for (const [id, p] of live) {
      const iso = isolate(p, this.ctx);
      if (iso) this.iso.set(id, iso);
    }
    // rows that arrived before any envelope ts (topology / cmd / invalid): sim_ts is NULL, fold in id order
    this.headStmt = this.source.prepare(
      `SELECT id, sim_ts, recv_ts, service, topic, payload, retained FROM raw_messages
       WHERE service = ? AND sim_ts IS NULL AND id > ? ORDER BY id LIMIT ?`,
    );
    // timed rows in (sim_ts, id) order — the live arrival order for a service whose sim clock is monotonic
    this.timedStmt = this.source.prepare(
      `SELECT id, sim_ts, recv_ts, service, topic, payload, retained FROM raw_messages
       WHERE service = ? AND sim_ts IS NOT NULL AND sim_ts <= ?
         AND (sim_ts > ? OR (sim_ts = ? AND id > ?))
       ORDER BY sim_ts, id LIMIT ?`,
    );
    this.snapStmt = this.source.prepare(
      `SELECT sim_ts, json FROM state_snapshots WHERE service = ? AND sim_ts <= ? ORDER BY sim_ts DESC LIMIT 1`,
    );
  }

  /** The isolated plugin for a service; its public `state` is the reconstructed reducer state. */
  plugin(id: string): Plugin | undefined {
    return this.iso.get(id);
  }

  services(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Fold every service forward to sim time t. The first call seeds each service from its nearest snapshot
   * ≤ t — restoring both the plugin reducer state and the generic StateStore, then replaying the head rows
   * that carry $topology — and folds the timed rows up to t. Later calls fold only the rows past the last
   * position, so play ticks and step-forward never re-apply a row to a non-idempotent reducer.
   */
  foldUpTo(t: number, opts: { snapshots?: boolean } = {}): void {
    const useSnapshots = opts.snapshots !== false;
    for (const service of this.live.keys()) {
      let cur = this.cursor.get(service);
      if (!cur) this.cursor.set(service, (cur = { ready: false, sim: 0, id: -1 }));
      if (!cur.ready) {
        const iso = this.iso.get(service);
        let lowerTs: number | null = null; // null → no snapshot: fold the whole history from the beginning
        if (useSnapshots) {
          const snap = this.snapStmt.get(service, t) as { sim_ts: number; json: string } | undefined;
          if (snap && this.restoreFrom(service, iso, snap.json)) lowerTs = snap.sim_ts;
        }
        // With a snapshot the head rows are already reflected in it, so replay only the $topology ones (the
        // registry is not part of a snapshot); without one, fold every head row.
        this.foldHead(service, lowerTs !== null);
        cur.sim = lowerTs === null ? Number.MIN_SAFE_INTEGER : lowerTs;
        cur.id = lowerTs === null ? -1 : Number.MAX_SAFE_INTEGER;
        cur.ready = true;
      }
      this.foldTimed(service, cur, t);
    }
  }

  /**
   * Restores a stored checkpoint: the generic StateStore for the service plus the isolated plugin's reducer
   * `state`, mutated in place (RTA/OPG control views hold a reference to it). True when a usable object was
   * parsed, so the caller treats the checkpoint's sim_ts as the fold's lower bound.
   */
  private restoreFrom(service: string, iso: Plugin | undefined, json: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object') return false;
    const snap = parsed as { plugin?: unknown; generic?: unknown };
    if (snap.generic && typeof snap.generic === 'object') {
      this.state.restore(service, snap.generic as ServiceState);
    }
    const target = iso ? (iso as unknown as { state?: unknown }).state : undefined;
    if (snap.plugin && typeof snap.plugin === 'object' && target && typeof target === 'object') {
      Object.assign(target as Record<string, unknown>, snap.plugin as Record<string, unknown>);
    }
    return true;
  }

  /** Fold the sim_ts-IS-NULL head rows; when a snapshot was restored, replay only the $topology ones. */
  private foldHead(service: string, topologyOnly: boolean): void {
    const keep = topologyOnly ? (p: Parsed) => p.kind === 'topology' : undefined;
    let lastId = -1;
    for (;;) {
      const rows = this.headStmt.all(service, lastId, CHUNK) as RawRow[];
      if (rows.length === 0) break;
      for (const r of rows) this.foldRow(r, keep);
      lastId = rows[rows.length - 1]!.id;
      if (rows.length < CHUNK) break;
    }
  }

  /** Fold timed rows past the cursor's last position, up to and including sim time t. */
  private foldTimed(service: string, cur: Cursor, t: number): void {
    for (;;) {
      const rows = this.timedStmt.all(service, t, cur.sim, cur.sim, cur.id, CHUNK) as RawRow[];
      if (rows.length === 0) break;
      for (const r of rows) this.foldRow(r);
      const last = rows[rows.length - 1]!;
      cur.sim = last.sim_ts as number;
      cur.id = last.id;
      if (rows.length < CHUNK) break;
    }
  }

  /** Re-parse one stored raw row with the live plugin's parser, then run it through the isolated reducer. */
  private foldRow(r: RawRow, keep?: (p: Parsed) => boolean): void {
    const live = this.live.get(r.service);
    const payload = Buffer.from(r.payload, 'utf8');
    const retained = r.retained === 1;
    let parsed: Parsed[];
    try {
      parsed = live
        ? live.parse(r.topic, payload, r.recv_ts, retained)
        : [parseMessage(r.topic, payload, r.recv_ts, retained)];
    } catch {
      parsed = [parseMessage(r.topic, payload, r.recv_ts, retained)];
    }
    // removed state (empty retained payload) has no envelope ts: stamp it with the stored sim_ts, exactly
    // as handleMessage did when the row was written, so the reducer sees the same value the live path did.
    const stamp = r.sim_ts;
    if (stamp !== null) {
      for (const p of parsed) if (p.kind === 'state' && p.removed && p.simTs === null) p.simTs = stamp;
    }
    const iso = this.iso.get(r.service);
    for (const p of parsed) if (!keep || keep(p)) this.dispatch(p, iso);
  }

  /** Mirrors Platform.dispatch for the parts that build reducer state (skips seq/acks/aggregates/alerts/SSE). */
  private dispatch(p: Parsed, iso: Plugin | undefined): void {
    if (p.kind === 'topology') {
      this.topology.set(p.service, p.topology);
      iso?.onTopology?.(p.topology);
      return; // live returns here too: topology never reaches state.apply or derive
    }
    if ((p.kind === 'telemetry' && !p.backfill) || p.kind === 'event') this.clock.observe(p.service, p.simTs, p.recvTs);
    this.state.apply(p);
    try {
      iso?.derive?.(p);
    } catch {
      /* mirror live: a throwing derive is logged and ignored */
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.scratch.close();
    } catch {
      /* already closed */
    }
  }
}
