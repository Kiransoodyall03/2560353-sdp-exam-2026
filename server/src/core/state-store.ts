// Generic in-memory state per service/entity: retained state items + latest live telemetry per stream.
// Deterministic reducer over Parsed messages, so replay can fold the same code (snapshot()/restore()).
import type { Parsed } from './parse.js';

export interface StateValue {
  value: unknown;
  ts: number | null;
  recvTs: number;
}
export interface TelemetryValue {
  fields: Record<string, unknown>;
  ts: number;
  recvTs: number;
  seq: number | null;
}
export interface EntityState {
  id: string;
  state: Record<string, StateValue>;
  telemetry: Record<string, TelemetryValue>;
  lastTs: number | null; // latest live telemetry/event sim ts (heartbeat)
  lastRecvTs: number | null;
}
export interface ServiceState {
  service: string;
  entities: Record<string, EntityState>;
  messages: number;
  lastSimTs: number | null;
  lastRecvTs: number | null;
}

export type StateChange =
  | { kind: 'state'; service: string; entity: string; item: string; value: unknown; removed: boolean }
  | { kind: 'telemetry'; service: string; entity: string; stream: string };

export class StateStore {
  private services: Record<string, ServiceState> = {};

  service(service: string): ServiceState {
    let s = this.services[service];
    if (!s) this.services[service] = s = { service, entities: {}, messages: 0, lastSimTs: null, lastRecvTs: null };
    return s;
  }

  entity(service: string, id: string): EntityState {
    const s = this.service(service);
    let e = s.entities[id];
    if (!e) s.entities[id] = e = { id, state: {}, telemetry: {}, lastTs: null, lastRecvTs: null };
    return e;
  }

  hasEntity(service: string, id: string): boolean {
    return !!this.services[service]?.entities[id];
  }

  apply(p: Parsed): StateChange | null {
    if (p.kind === 'invalid' || p.kind === 'cmd' || p.kind === 'topology') return null;
    const s = this.service(p.service);
    s.messages++;
    s.lastRecvTs = p.recvTs;
    if (p.kind === 'state') {
      const e = this.entity(p.service, p.entity);
      if (p.removed) delete e.state[p.item];
      else e.state[p.item] = { value: p.value, ts: p.simTs, recvTs: p.recvTs };
      return { kind: 'state', service: p.service, entity: p.entity, item: p.item, value: p.value, removed: p.removed };
    }
    if (p.kind === 'telemetry') {
      if (p.backfill) return null; // old data re-published after an outage: stored, never treated as live
      const e = this.entity(p.service, p.entity);
      const prev = e.telemetry[p.stream];
      if (!prev || p.simTs >= prev.ts) e.telemetry[p.stream] = { fields: p.fields, ts: p.simTs, recvTs: p.recvTs, seq: p.seq };
      this.heartbeat(s, e, p.simTs, p.recvTs);
      return { kind: 'telemetry', service: p.service, entity: p.entity, stream: p.stream };
    }
    if (p.kind === 'event') {
      if (s.lastSimTs === null || p.simTs > s.lastSimTs) s.lastSimTs = p.simTs;
      return null;
    }
    return null;
  }

  private heartbeat(s: ServiceState, e: EntityState, ts: number, recvTs: number) {
    if (e.lastTs === null || ts >= e.lastTs) {
      e.lastTs = ts;
      e.lastRecvTs = recvTs;
    }
    if (s.lastSimTs === null || ts > s.lastSimTs) s.lastSimTs = ts;
  }

  value<T = unknown>(service: string, entity: string, item: string): T | undefined {
    return this.services[service]?.entities[entity]?.state[item]?.value as T | undefined;
  }

  latest(service: string, entity: string, stream: string): TelemetryValue | undefined {
    return this.services[service]?.entities[entity]?.telemetry[stream];
  }

  online(service: string): boolean | null {
    const v = this.value(service, 'global', 'online');
    return typeof v === 'boolean' ? v : null;
  }

  activeAlerts(service: string): string[] | null {
    const v = this.value(service, 'global', 'active_alerts');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  }

  snapshot(service: string): ServiceState {
    return structuredClone(this.service(service));
  }

  restore(service: string, snap: ServiceState): void {
    this.services[service] = structuredClone(snap);
  }
}
