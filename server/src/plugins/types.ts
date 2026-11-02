// Plugin contract. Generic parts (topology, state store, alerts, commands, replay, SSE, health) live in core;
// a plugin adds what is specific to one service.
import type { FastifyInstance } from 'fastify';
import type { KpiDTO, ServiceId, ServiceTopology, TopologyEntity } from '../../../shared/types.js';
import type { ArlApiClient } from '../arl-api/client.js';
import type { AlertStore } from '../alerts/store.js';
import type { SimClock } from '../core/clock.js';
import type { Parsed } from '../core/parse.js';
import type { SseHub } from '../core/sse.js';
import type { StateStore } from '../core/state-store.js';
import type { TopologyRegistry } from '../core/topology.js';
import type { Aggregator } from '../db/aggregates.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../log.js';

export interface PlatformContext {
  db: Db;
  topology: TopologyRegistry;
  state: StateStore;
  clock: SimClock;
  sse: SseHub;
  api: ArlApiClient;
  alerts: AlertStore;
  aggregator: Aggregator;
  log: Logger;
  /** Synchronously drains the write queue (e.g. before reading a finished scan back from SQLite). */
  flush(): void;
}

/** Any of `streams` arriving within 3 × periodS counts as alive. */
export interface StreamExpectation {
  streams: string[];
  periodS: number;
}

export type Kpi = KpiDTO;

/** Placeholder for P4 (controls): zod schema, safeguards, presets. */
export interface CommandSpec {
  control: string;
  entityKinds: string[];
}

export interface Plugin {
  readonly id: ServiceId;
  /** Pure: topic + payload → parsed messages. Never throws. */
  parse(topic: string, payload: Buffer, recvTs: number, retained: boolean): Parsed[];
  init?(ctx: PlatformContext): void;
  onTopology?(t: ServiceTopology): void;
  /** Runs inside the writer transaction with the batch's parsed messages for this service. */
  persist?(batch: Parsed[], db: Db): void;
  /** Folds one message into plugin state (same code for live and replay). */
  derive?(msg: Parsed): void;
  expectations?(entity: TopologyEntity): StreamExpectation | null;
  kpis?(): Kpi[];
  snapshot?(): unknown;
  restore?(snapshot: unknown): void;
  routes?(app: FastifyInstance): void;
  readonly commands: CommandSpec[];
}
