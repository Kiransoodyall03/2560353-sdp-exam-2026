// Platform core: MQTT message → raw row (always, first) → parse → dispatch to generic state, alerts,
// health, aggregates and the service plugin. Also computes service health and raises platform alerts.
import {
  SERVICES,
  isServiceId,
  type OverviewDTO,
  type PlatformHealthDTO,
  type ServiceHealthDTO,
  type SilentStream,
} from '../../../shared/types.js';
import { ApiError, type ArlApiClient } from '../arl-api/client.js';
import { PlaceholderEnricher } from '../alerts/backlog.js';
import { publicAlert } from '../alerts/public.js';
import { AlertStore } from '../alerts/store.js';
import { AlertWorkflow, parseAlertPayload } from '../alerts/workflow.js';
import { Aggregator } from '../db/aggregates.js';
import type { Db } from '../db/index.js';
import { BatchWriter, genericPersister, type Persister, type WriterOptions } from '../db/writer.js';
import type { Logger } from '../log.js';
import type { Plugin, PlatformContext } from '../plugins/types.js';
import { ResearcherVerifier } from '../researchers/verify.js';
import { SimClock } from './clock.js';
import { parseMessage, type Parsed } from './parse.js';
import { SeqTracker } from './seq-tracker.js';
import { SseHub } from './sse.js';
import { StateStore } from './state-store.js';
import { classifyTopic } from './topics.js';
import { TopologyRegistry } from './topology.js';

export interface PlatformDeps {
  db: Db;
  api: ArlApiClient;
  log: Logger;
  plugins: Plugin[];
  wallNow?: () => number;
  writer?: Partial<WriterOptions>;
}

const SILENT_WALL_FLOOR_MS = 5_000;
const SEQ_GAP_HOLD_MS = 5 * 60_000;

export class Platform {
  readonly db: Db;
  readonly api: ArlApiClient;
  readonly log: Logger;
  readonly topology = new TopologyRegistry();
  readonly state = new StateStore();
  readonly clock: SimClock;
  readonly seq: SeqTracker;
  readonly sse: SseHub;
  readonly aggregator = new Aggregator();
  readonly writer: BatchWriter;
  readonly alertStore: AlertStore;
  readonly alerts: AlertWorkflow;
  readonly enricher: PlaceholderEnricher;
  readonly verifier: ResearcherVerifier;
  readonly plugins = new Map<string, Plugin>();
  readonly ctx: PlatformContext;
  private readonly wallNow: () => number;

  readonly broker = { connected: false, sinceWallTs: null as number | null, reconnects: 0, error: null as string | null };
  readonly apiState = {
    reachable: null as boolean | null,
    status: null as string | null,
    lastCheckWallTs: null as number | null,
    error: null as string | null,
    failures: 0,
  };
  private readonly firstSim = new Map<string, number>();
  private readonly messages = new Map<string, number>();
  private totalMessages = 0;
  private rate = { lastCount: 0, lastWall: 0, perSec: 0 };
  private timers: NodeJS.Timeout[] = [];

  constructor(deps: PlatformDeps) {
    this.db = deps.db;
    this.api = deps.api;
    this.log = deps.log;
    this.wallNow = deps.wallNow ?? Date.now;
    this.clock = new SimClock(this.wallNow);
    this.seq = new SeqTracker(this.wallNow);
    this.sse = new SseHub(() => this.clock.globalNow());
    this.alertStore = new AlertStore(this.db, this.wallNow);
    this.alerts = new AlertWorkflow(this.alertStore);
    this.enricher = new PlaceholderEnricher(this.api, this.alertStore, this.alerts, (s) => this.clock.now(s), this.log);
    this.verifier = new ResearcherVerifier(this.api);
    for (const p of deps.plugins) this.plugins.set(p.id, p);

    const pluginPersister: Persister = (batch, db) => {
      for (const p of this.plugins.values()) {
        if (!p.persist) continue;
        const mine = batch.filter((m) => m.service === p.id);
        if (mine.length) p.persist(mine, db);
      }
    };
    const aggregatePersister: Persister = (_batch, db) => {
      this.aggregator.flush(db);
    };
    this.writer = new BatchWriter(this.db, [genericPersister(), pluginPersister, aggregatePersister], deps.writer);
    this.writer.onDegradedChange = (d) => {
      const now = this.clock.globalNow();
      if (d) {
        this.alerts.raisePlatform(
          {
            subject: 'ingestion',
            type: 'ingestion_degraded',
            severity: 'critical',
            message: 'Ingestion degraded: write queue overflowed, storing raw messages only',
            value: this.writer.stats.queueDepth,
          },
          now,
        );
      } else this.alerts.clearPlatform('ingestion', 'ingestion_degraded', now);
    };
    this.writer.onError = (err) => this.log.error({ err }, 'writer flush failed');

    this.ctx = {
      db: this.db,
      topology: this.topology,
      state: this.state,
      clock: this.clock,
      sse: this.sse,
      api: this.api,
      alerts: this.alertStore,
      aggregator: this.aggregator,
      log: this.log,
      flush: () => {
        while (this.writer.stats.queueDepth > 0 && this.writer.flush() > 0) {
          /* drain */
        }
      },
    };
    for (const p of this.plugins.values()) p.init?.(this.ctx);
    this.registerChannels();
  }

  start(): void {
    this.writer.start();
    this.sse.start();
    this.timers.push(setInterval(() => this.healthTick(), 2_000));
    this.timers.push(setInterval(() => void this.checkApi(), 15_000));
    this.timers.push(setInterval(() => void this.refreshCatalogue(), 5 * 60_000));
    for (const t of this.timers) t.unref?.();
    void this.checkApi();
    void this.refreshCatalogue();
    for (const svc of SERVICES) {
      if (this.alertStore.openForService(svc).some((a) => a.placeholder)) this.enricher.request(svc);
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.sse.stop();
    this.writer.stop();
  }

  // ---------------------------------------------------------------- ingestion
  handleMessage(topic: string, payload: Buffer, retained: boolean): void {
    const recvTs = this.wallNow();
    const info = classifyTopic(topic);
    const service = info.service ?? 'unknown';
    const plugin = this.plugins.get(service);
    let parsed: Parsed[];
    try {
      parsed = plugin ? plugin.parse(topic, payload, recvTs, retained) : [parseMessage(topic, payload, recvTs, retained)];
    } catch (err) {
      this.log.warn({ err, topic }, 'plugin parse threw');
      parsed = [parseMessage(topic, payload, recvTs, retained)];
    }
    const first = parsed[0];
    const simTs = first?.simTs ?? this.clock.now(service);
    // removed state (empty retained payload) has no envelope ts: stamp with the service's sim clock
    for (const p of parsed) if (p.kind === 'state' && p.removed && p.simTs === null) p.simTs = simTs;

    // rule 3: append to raw_messages (batched) before plugin dispatch
    this.writer.enqueue(
      {
        simTs,
        recvTs,
        service,
        entity: first?.entity ?? null,
        kind: first?.kind ?? 'invalid',
        topic,
        payload: payload.toString('utf8'),
        retained,
      },
      isServiceId(service) ? parsed : null,
    );

    this.totalMessages++;
    this.messages.set(service, (this.messages.get(service) ?? 0) + 1);
    if (!isServiceId(service)) return; // MHE/OWT are recorded raw only (not built)
    for (const p of parsed) this.dispatch(p, plugin);
  }

  private dispatch(p: Parsed, plugin: Plugin | undefined): void {
    const svc = p.service;
    if (p.kind === 'topology') {
      this.topology.set(svc, p.topology);
      plugin?.onTopology?.(p.topology);
      this.sse.patch(`svc:${svc}`, '$topology', p.topology);
      return;
    }
    if ((p.kind === 'telemetry' && !p.backfill) || p.kind === 'event') {
      this.clock.observe(svc, p.simTs, p.recvTs);
      if (!this.firstSim.has(svc)) this.firstSim.set(svc, p.simTs);
    }
    if (p.kind === 'telemetry' || p.kind === 'event') this.seq.observe(svc, p.topic, p.seq, p.kind === 'telemetry' && p.backfill);

    const change = this.state.apply(p);

    if (p.kind === 'telemetry') {
      for (const key of this.topology.numericFields(svc, p.entity, p.stream)) {
        const v = p.fields[key];
        if (typeof v === 'number') this.aggregator.add(svc, p.entity, key, p.simTs, v);
      }
    }
    if (p.kind === 'event' && p.event === 'alert') {
      const a = parseAlertPayload(p.body);
      if (a) this.alerts.ingest(svc as (typeof SERVICES)[number], a);
      else this.log.warn({ topic: p.topic }, 'invalid alert payload');
    }
    if (p.kind === 'state' && p.entity === 'global') {
      if (p.item === 'active_alerts' && Array.isArray(p.value)) {
        const ids = p.value.filter((x): x is string => typeof x === 'string');
        const changes = this.alerts.reconcile(svc as (typeof SERVICES)[number], ids, p.simTs);
        if (changes.some((c) => c.action === 'reconciled_placeholder')) this.enricher.request(svc as (typeof SERVICES)[number]);
      }
      if (p.item === 'online') this.onOnline(svc, p.removed ? null : p.value === true, p.simTs);
    }
    try {
      plugin?.derive?.(p);
    } catch (err) {
      this.log.warn({ err, topic: p.topic }, 'plugin derive threw');
    }
    if (change) {
      this.sse.patch(`svc:${svc}`, `entity:${change.entity}`, this.state.service(svc).entities[change.entity] ?? null);
    }
  }

  private onOnline(svc: string, online: boolean | null, simTs: number | null): void {
    if (online === false) {
      this.alerts.raisePlatform(
        {
          subject: svc,
          type: 'service_offline',
          severity: 'critical',
          entity: 'global',
          message: `${svc.toUpperCase()} service is offline (online = false)`,
        },
        simTs,
      );
    } else if (online === true) {
      this.alerts.clearPlatform(svc, 'service_offline', simTs);
    }
  }

  setBroker(connected: boolean, error: string | null = null): void {
    const was = this.broker.connected;
    this.broker.connected = connected;
    this.broker.error = error;
    const now = this.clock.globalNow();
    if (connected && !was) {
      this.broker.sinceWallTs = this.wallNow();
      this.alerts.clearPlatform('broker', 'broker_disconnected', now);
    } else if (!connected && (was || this.broker.sinceWallTs === null)) {
      if (was) this.broker.reconnects++;
      this.broker.sinceWallTs = this.wallNow();
      this.alerts.raisePlatform(
        {
          subject: 'broker',
          type: 'broker_disconnected',
          severity: 'critical',
          message: `MQTT broker disconnected${error ? `: ${error}` : ''}`,
        },
        now,
      );
    }
  }

  async checkApi(): Promise<void> {
    const now = this.clock.globalNow();
    this.apiState.lastCheckWallTs = this.wallNow();
    try {
      const h = await this.api.health();
      this.apiState.reachable = true;
      this.apiState.status = h.status;
      this.apiState.error = null;
      this.apiState.failures = 0;
      if (h.status === 'ok') this.alerts.clearPlatform('api', 'api_unreachable', now);
      else {
        this.alerts.raisePlatform(
          {
            subject: 'api',
            type: 'api_unreachable',
            severity: 'warning',
            message: `ARL API reports ${h.status} (database ${h.database ? 'up' : 'down'}, broker ${h.broker === false ? 'down' : 'up'})`,
          },
          now,
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'rate_limited') {
        this.apiState.reachable = true;
        this.apiState.status = 'rate_limited';
        return;
      }
      this.apiState.failures++;
      this.apiState.error = err instanceof Error ? err.message : String(err);
      if (this.apiState.failures >= 2) {
        this.apiState.reachable = false;
        this.alerts.raisePlatform(
          { subject: 'api', type: 'api_unreachable', severity: 'critical', message: 'ARL API unreachable' },
          now,
        );
      }
    }
  }

  private async refreshCatalogue(): Promise<void> {
    await Promise.allSettled([this.api.targets(), ...SERVICES.map((s) => this.api.alertLimits(s))]);
  }

  // ---------------------------------------------------------------- health
  serviceHealth(svc: (typeof SERVICES)[number]): ServiceHealthDTO {
    const s = this.state.service(svc);
    const simNow = this.clock.now(svc);
    const online = this.state.online(svc);
    const silent: SilentStream[] = [];
    const plugin = this.plugins.get(svc);
    const topo = this.topology.get(svc);
    const first = this.firstSim.get(svc);
    const wall = this.wallNow();
    if (topo && simNow !== null && first !== undefined && online !== false) {
      for (const ent of topo.entities) {
        const exp = plugin?.expectations?.(ent);
        if (!exp) continue;
        const e = s.entities[ent.id];
        const lastTs = e?.lastTs ?? null;
        const ref = Math.max(lastTs ?? first, first);
        const simAge = simNow - ref;
        const wallAge = e?.lastRecvTs ? wall - e.lastRecvTs : wall - (this.clock.lastWall(svc) ?? wall);
        if (simAge > 3 * exp.periodS * 1000 && (lastTs === null || wallAge > SILENT_WALL_FLOOR_MS)) {
          silent.push({ entity: ent.id, stream: exp.streams.join('|'), lastTs, periodS: exp.periodS });
        }
      }
    }
    const onlineSince = s.entities['global']?.state['online']?.ts ?? null;
    return {
      service: svc,
      online,
      onlineSinceTs: onlineSince,
      lastSeenSimTs: s.lastSimTs,
      lastSeenWallTs: s.lastRecvTs,
      simNow,
      speedup: this.clock.rate(svc),
      topologyVersion: topo?.version ?? null,
      entityCount: topo?.entities.length ?? 0,
      messages: this.messages.get(svc) ?? 0,
      silent,
      seqGaps: this.seq.stats(svc),
      activeAlertIds: this.state.activeAlerts(svc)?.length ?? 0,
    };
  }

  platformHealth(): PlatformHealthDTO {
    const w = this.writer.stats;
    return {
      wallTs: this.wallNow(),
      broker: { ...this.broker },
      api: {
        reachable: this.apiState.reachable,
        status: this.apiState.status,
        lastCheckWallTs: this.apiState.lastCheckWallTs,
        error: this.apiState.error,
      },
      ingestion: {
        degraded: w.degraded,
        queueDepth: w.queueDepth,
        written: w.written,
        dropped: w.dropped,
        rawOnly: w.rawOnly,
        lastFlushMs: w.lastFlushMs,
        msgPerSec: this.rate.perSec,
      },
      services: SERVICES.map((s) => this.serviceHealth(s)),
    };
  }

  overview(): OverviewDTO {
    const platform = this.platformHealth();
    const summary = this.alertStore.summary();
    return {
      platform,
      alerts: summary,
      services: platform.services.map((h) => ({
        health: h,
        kpis: this.plugins.get(h.service)?.kpis?.() ?? [],
        alerts: summary.byService[h.service] ?? { unacked: 0, open: 0 },
      })),
    };
  }

  healthTick(): void {
    const wall = this.wallNow();
    if (this.rate.lastWall) {
      const dt = (wall - this.rate.lastWall) / 1000;
      if (dt > 0) this.rate.perSec = Math.round(((this.totalMessages - this.rate.lastCount) / dt) * 10) / 10;
    }
    this.rate.lastWall = wall;
    this.rate.lastCount = this.totalMessages;

    for (const svc of SERVICES) {
      const h = this.serviceHealth(svc);
      const now = h.simNow;
      if (h.silent.length) {
        this.alerts.raisePlatform(
          {
            subject: svc,
            type: 'stream_silent',
            severity: 'warning',
            entity: h.silent.length === 1 ? h.silent[0]!.entity : null,
            message: `${h.silent.length} ${svc.toUpperCase()} ${h.silent.length === 1 ? 'entity has' : 'entities have'} been silent for more than 3 stream periods`,
            value: h.silent.length,
            metadata: { silent: h.silent.slice(0, 25).map((s) => `${s.entity} (${s.stream}, ${s.periodS} s)`) },
          },
          now,
        );
      } else this.alerts.clearPlatform(svc, 'stream_silent', now);

      const g = h.seqGaps;
      if (g.lastGapWallTs !== null && wall - g.lastGapWallTs < SEQ_GAP_HOLD_MS && (g.outstanding > 0 || g.total > 0)) {
        this.alerts.raisePlatform(
          {
            subject: svc,
            type: 'seq_gap',
            severity: g.outstanding >= 10 ? 'warning' : 'info',
            message: `${svc.toUpperCase()}: ${g.outstanding} message(s) missing (sequence gaps; ${g.total} detected in total)`,
            value: g.outstanding,
            metadata: { topics: this.seq.gapTopics(svc) },
          },
          now,
        );
      } else this.alerts.clearPlatform(svc, 'seq_gap', now);
    }
    this.sse.patch('overview', 'overview', this.overview());
  }

  // ---------------------------------------------------------------- SSE channels
  private registerChannels(): void {
    this.sse.register('overview', () => ({ overview: this.overview() }));
    this.sse.register('alerts', () => ({
      alerts: this.alertStore.openAlerts().map(publicAlert),
      summary: this.alertStore.summary(),
    }));
    for (const svc of SERVICES) {
      this.sse.register(`svc:${svc}`, () => ({
        $topology: this.topology.get(svc),
        ...Object.fromEntries(Object.entries(this.state.service(svc).entities).map(([k, v]) => [`entity:${k}`, v])),
      }));
    }
    this.alerts.onChange(({ alert }) => {
      this.sse.patch('alerts', alert.key, publicAlert(alert));
      this.sse.patch('alerts', 'summary', this.alertStore.summary());
    });
  }
}
