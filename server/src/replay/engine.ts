// ReplayEngine: owns the in-memory replay sessions. A session pins a sim-time cursor t over our stored
// raw_messages; seek / play / step move t and rebuild per-service state by folding through a ReplayFold,
// pushing deltas on the SSE channel `replay:<id>`. Read-only: it never touches live state, and control
// routes refuse requests carrying the session header (see routes/replay.ts).
import type { AlertDTO, KpiDTO } from '../../../shared/types.js';
import { publicAlert } from '../alerts/public.js';
import type { ArlApiClient } from '../arl-api/client.js';
import type { SseHub } from '../core/sse.js';
import type { Db } from '../db/index.js';
import { maskCode } from '../log.js';
import type { Plugin } from '../plugins/types.js';
import { alertStateAtT, summarize } from './alerts.js';
import { ReplayFold } from './fold.js';
import {
  IDLE_MS,
  MARKER_CAP,
  MAX_SESSIONS,
  PUSH_MIN_MS,
  REPLAY_PREFIX,
  TICK_MS,
  type ReplayMarker,
  type ReplayRange,
  type ReplayRangeDTO,
  type ReplaySession,
  type ReplayStateDTO,
  type ServiceReplayState,
  type Speed,
} from './types.js';

/** A replay-specific error the route layer maps to {error: code, detail: message} at `status`. */
export class ReplayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface SessionEntry {
  session: ReplaySession;
  fold: ReplayFold;
  lastActivity: number;
  lastPush: number;
  timer: NodeJS.Timeout | null;
}

export interface ReplayDeps {
  db: Db;
  plugins: Map<string, Plugin>;
  api: ArlApiClient;
  sse: SseHub;
  wallNow?: () => number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class ReplayEngine {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly db: Db;
  private readonly plugins: Map<string, Plugin>;
  private readonly api: ArlApiClient;
  private readonly sse: SseHub;
  private readonly wallNow: () => number;

  constructor(deps: ReplayDeps) {
    this.db = deps.db;
    this.plugins = deps.plugins;
    this.api = deps.api;
    this.sse = deps.sse;
    this.wallNow = deps.wallNow ?? Date.now;
    // Subscribing to `replay:<id>` sends the session state once; play then patches the same keys (≤ 4/s).
    this.sse.registerPrefix(REPLAY_PREFIX, (channel) => {
      const entry = this.sessions.get(channel.slice(REPLAY_PREFIX.length));
      return entry ? this.snapshotPayload(entry) : { mode: 'replay', error: 'unknown_session' };
    });
  }

  // ------------------------------------------------------------------ range / markers
  range(): ReplayRangeDTO {
    const overall = this.db
      .prepare(`SELECT MIN(sim_ts) AS min, MAX(sim_ts) AS max FROM raw_messages WHERE sim_ts IS NOT NULL`)
      .get() as { min: number | null; max: number | null };
    const rows = this.db
      .prepare(
        `SELECT service, MIN(sim_ts) AS min, MAX(sim_ts) AS max FROM raw_messages
         WHERE sim_ts IS NOT NULL GROUP BY service`,
      )
      .all() as { service: string; min: number | null; max: number | null }[];
    const services: Record<string, ReplayRange> = {};
    for (const r of rows) services[r.service] = { min: r.min, max: r.max };
    return { overall: { min: overall.min ?? null, max: overall.max ?? null }, services };
  }

  /** Alert events, commands and RTA scan start/end in [from, to], sorted by time and capped at 2,000. */
  markers(from: number, to: number): { from: number; to: number; markers: ReplayMarker[]; truncated: boolean } {
    const markers: ReplayMarker[] = [];
    const events = this.db
      .prepare(
        `SELECT service, alert_id, sim_ts, action, actor, detail_json FROM alert_events
         WHERE sim_ts IS NOT NULL AND sim_ts BETWEEN ? AND ? ORDER BY sim_ts, id`,
      )
      .all(from, to) as {
      service: string;
      alert_id: string;
      sim_ts: number;
      action: string;
      actor: string | null;
      detail_json: string;
    }[];
    for (const r of events) {
      const d = safeJson(r.detail_json);
      const sev = typeof d['severity'] === 'string' ? d['severity'] : typeof d['to'] === 'string' ? d['to'] : undefined;
      markers.push({
        ts: r.sim_ts,
        kind: 'alert',
        service: r.service,
        alertId: r.alert_id,
        action: r.action,
        ...(sev ? { severity: sev } : {}),
        actor: r.actor ? maskCode(r.actor) : null,
      });
    }
    const commands = this.db
      .prepare(
        `SELECT command_id, service, control, researcher, requested_ts, state FROM commands
         WHERE requested_ts BETWEEN ? AND ? ORDER BY requested_ts`,
      )
      .all(from, to) as {
      command_id: string;
      service: string;
      control: string;
      researcher: string;
      requested_ts: number;
      state: string;
    }[];
    for (const r of commands) {
      markers.push({
        ts: r.requested_ts,
        kind: 'command',
        service: r.service,
        commandId: r.command_id,
        control: r.control,
        researcher: maskCode(r.researcher),
        outcome: r.state,
      });
    }
    const scans = this.db
      .prepare(
        `SELECT scan_id, started_ts, ended_ts FROM rta_scans
         WHERE (started_ts IS NOT NULL AND started_ts BETWEEN ? AND ?)
            OR (ended_ts IS NOT NULL AND ended_ts BETWEEN ? AND ?)`,
      )
      .all(from, to, from, to) as { scan_id: string; started_ts: number | null; ended_ts: number | null }[];
    for (const r of scans) {
      if (r.started_ts !== null && r.started_ts >= from && r.started_ts <= to) {
        markers.push({ ts: r.started_ts, kind: 'scan_start', service: 'rta', scanId: r.scan_id });
      }
      if (r.ended_ts !== null && r.ended_ts >= from && r.ended_ts <= to) {
        markers.push({ ts: r.ended_ts, kind: 'scan_end', service: 'rta', scanId: r.scan_id });
      }
    }
    markers.sort((a, b) => a.ts - b.ts);
    const truncated = markers.length > MARKER_CAP;
    return { from, to, markers: markers.slice(0, MARKER_CAP), truncated };
  }

  // ------------------------------------------------------------------ sessions
  create(t: number, speed: Speed = 1): ReplaySession {
    this.reap();
    const r = this.range();
    if (r.overall.min === null || r.overall.max === null) {
      throw new ReplayError('no_data', 'No stored messages to replay yet.', 409);
    }
    if (this.sessions.size >= MAX_SESSIONS) this.evictLru();
    const id = this.newId();
    const from = r.overall.min;
    const to = r.overall.max;
    const session: ReplaySession = {
      id,
      t: clamp(t, from, to),
      speed,
      playing: false,
      from,
      to,
      createdAt: this.wallNow(),
    };
    const fold = new ReplayFold(this.db, this.plugins, this.api);
    fold.foldUpTo(session.t);
    this.sessions.set(id, { session, fold, lastActivity: this.wallNow(), lastPush: 0, timer: null });
    return session;
  }

  seek(id: string, t: number): ReplaySession {
    const e = this.get(id);
    const target = clamp(t, e.session.from, e.session.to);
    // Rebuild from the nearest snapshot ≤ target: a fresh fold keeps this correct in both directions.
    e.fold.dispose();
    e.fold = new ReplayFold(this.db, this.plugins, this.api);
    e.fold.foldUpTo(target);
    e.session.t = target;
    e.lastActivity = this.wallNow();
    this.push(e, true);
    return e.session;
  }

  play(id: string): ReplaySession {
    const e = this.get(id);
    e.lastActivity = this.wallNow();
    if (e.session.playing) return e.session;
    e.session.playing = true;
    e.timer = setInterval(() => this.tick(id), TICK_MS);
    e.timer.unref?.();
    this.push(e, true);
    return e.session;
  }

  pause(id: string): ReplaySession {
    const e = this.get(id);
    this.stopPlayback(e);
    e.lastActivity = this.wallNow();
    return e.session;
  }

  setSpeed(id: string, speed: Speed): ReplaySession {
    const e = this.get(id);
    e.session.speed = speed;
    e.lastActivity = this.wallNow();
    this.push(e, true);
    return e.session;
  }

  /** Move the cursor to the next (1) or previous (-1) distinct raw-message sim ts, then pause. */
  step(id: string, direction: 1 | -1): ReplaySession {
    const e = this.get(id);
    this.stopPlayback(e);
    const t = e.session.t;
    if (direction === 1) {
      const row = this.db
        .prepare(`SELECT MIN(sim_ts) AS ts FROM raw_messages WHERE sim_ts IS NOT NULL AND sim_ts > ?`)
        .get(t) as { ts: number | null };
      if (row.ts !== null) {
        e.session.t = clamp(row.ts, e.session.from, e.session.to);
        e.fold.foldUpTo(e.session.t); // forward: incremental on the existing fold
      }
    } else {
      const row = this.db
        .prepare(`SELECT MAX(sim_ts) AS ts FROM raw_messages WHERE sim_ts IS NOT NULL AND sim_ts < ?`)
        .get(t) as { ts: number | null };
      if (row.ts !== null) {
        e.session.t = clamp(row.ts, e.session.from, e.session.to);
        e.fold.dispose(); // backward: rebuild from the nearest snapshot
        e.fold = new ReplayFold(this.db, this.plugins, this.api);
        e.fold.foldUpTo(e.session.t);
      }
    }
    e.lastActivity = this.wallNow();
    this.push(e, true);
    return e.session;
  }

  remove(id: string): void {
    const e = this.sessions.get(id);
    if (!e) return;
    if (e.timer) clearInterval(e.timer);
    e.fold.dispose();
    this.sessions.delete(id);
  }

  state(id: string): ReplayStateDTO {
    const e = this.get(id);
    e.lastActivity = this.wallNow();
    return this.stateDTO(e);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  // ------------------------------------------------------------------ internals
  private tick(id: string): void {
    const e = this.sessions.get(id);
    if (!e || !e.session.playing) {
      if (e) this.stopPlayback(e);
      return;
    }
    const t = Math.min(e.session.t + TICK_MS * e.session.speed, e.session.to);
    e.session.t = t;
    e.fold.foldUpTo(t); // forward: folds only the new rows
    e.lastActivity = this.wallNow();
    this.push(e, false);
    if (t >= e.session.to) this.stopPlayback(e);
  }

  private stopPlayback(e: SessionEntry): void {
    if (e.timer) {
      clearInterval(e.timer);
      e.timer = null;
    }
    if (e.session.playing) {
      e.session.playing = false;
      this.push(e, true);
    }
  }

  /** Push the changed parts on the session channel, throttled to ≤ 4/s unless forced. */
  private push(e: SessionEntry, force: boolean): void {
    const channel = REPLAY_PREFIX + e.session.id;
    if (!this.sse.hasSubscribers(channel)) return; // no work while nobody is watching
    const now = this.wallNow();
    if (!force && now - e.lastPush < PUSH_MIN_MS) return;
    e.lastPush = now;
    const dto = this.stateDTO(e);
    this.sse.patch(channel, 't', dto.t);
    this.sse.patch(channel, 'playing', dto.playing);
    this.sse.patch(channel, 'speed', dto.speed);
    for (const [svc, st] of Object.entries(dto.services)) this.sse.patch(channel, `svc:${svc}`, st);
    this.sse.patch(channel, 'alerts', dto.alerts);
  }

  private snapshotPayload(e: SessionEntry): { mode: 'replay' } & ReplayStateDTO {
    return { mode: 'replay', ...this.stateDTO(e) };
  }

  private stateDTO(e: SessionEntry): ReplayStateDTO {
    const atT = alertStateAtT(this.db, e.session.t);
    e.fold.alertStore.set(atT); // plugin views (e.g. RTA dish badges) read the alerts as of t
    const services: Record<string, ServiceReplayState> = {};
    for (const svc of e.fold.services()) {
      const iso = e.fold.plugin(svc);
      services[svc] = {
        view: this.safeView(iso),
        state: e.fold.state.snapshot(svc),
        topology: e.fold.topology.get(svc),
        kpis: this.safeKpis(iso),
      };
    }
    return {
      id: e.session.id,
      t: e.session.t,
      from: e.session.from,
      to: e.session.to,
      speed: e.session.speed,
      playing: e.session.playing,
      services,
      alerts: { alerts: atT.map(publicAlert), summary: summarize(atT) },
    };
  }

  private safeView(iso: Plugin | undefined): unknown | null {
    if (!iso || typeof iso.snapshot !== 'function') return null;
    try {
      return iso.snapshot() ?? null;
    } catch {
      return null;
    }
  }

  private safeKpis(iso: Plugin | undefined): KpiDTO[] {
    if (!iso || typeof iso.kpis !== 'function') return [];
    try {
      return iso.kpis() ?? [];
    } catch {
      return [];
    }
  }

  private get(id: string): SessionEntry {
    const e = this.sessions.get(id);
    if (!e) throw new ReplayError('not_found', 'No such replay session.', 404);
    return e;
  }

  private newId(): string {
    for (;;) {
      const id = `rp_${Math.random().toString(36).slice(2, 12)}`;
      if (id.length >= 7 && !this.sessions.has(id)) return id;
    }
  }

  /** Drop sessions idle for > 30 min (called before creating a new one). */
  private reap(): void {
    const now = this.wallNow();
    for (const [id, e] of this.sessions) {
      if (now - e.lastActivity > IDLE_MS) {
        if (e.timer) clearInterval(e.timer);
        e.fold.dispose();
        this.sessions.delete(id);
      }
    }
  }

  private evictLru(): void {
    let oldestId: string | null = null;
    let oldest = Infinity;
    for (const [id, e] of this.sessions) {
      if (e.lastActivity < oldest) {
        oldest = e.lastActivity;
        oldestId = id;
      }
    }
    if (oldestId !== null) this.remove(oldestId);
  }
}
