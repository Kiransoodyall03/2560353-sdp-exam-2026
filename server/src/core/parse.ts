// Generic, pure parsing of the shared ARL envelope. Plugins refine the result with typed schemas.
import { z } from 'zod';
import type { ServiceTopology } from '../../../shared/types.js';
import { classifyTopic } from './topics.js';

export interface ParsedBase {
  service: string;
  topic: string;
  recvTs: number;
  retained: boolean;
}
export type ParsedTopology = ParsedBase & { kind: 'topology'; entity: 'global'; simTs: null; topology: ServiceTopology };
export type ParsedTelemetry = ParsedBase & {
  kind: 'telemetry';
  entity: string;
  stream: string;
  simTs: number;
  seq: number | null;
  fields: Record<string, unknown>;
  backfill: boolean;
};
export type ParsedState = ParsedBase & {
  kind: 'state';
  entity: string;
  item: string;
  simTs: number | null;
  value: unknown;
  removed: boolean;
};
export type ParsedEvent = ParsedBase & {
  kind: 'event';
  entity: string;
  event: string;
  simTs: number;
  seq: number | null;
  body: Record<string, unknown>;
};
export type ParsedAck = ParsedBase & {
  kind: 'ack';
  entity: string;
  commandId: string;
  simTs: number | null;
  body: Record<string, unknown>;
};
export type ParsedCmd = ParsedBase & {
  kind: 'cmd';
  entity: string;
  control: string;
  simTs: null;
  body: Record<string, unknown>;
};
export type ParsedInvalid = ParsedBase & { kind: 'invalid'; entity: string | null; simTs: number | null; reason: string };
export type Parsed = ParsedTopology | ParsedTelemetry | ParsedState | ParsedEvent | ParsedAck | ParsedCmd | ParsedInvalid;

export const ENVELOPE_KEYS = new Set(['v', 'ts', 'seq', 'entity']);

const Envelope = z
  .object({
    v: z.number().int(),
    ts: z.number().finite(),
    seq: z.number().int().nonnegative().nullable().optional(),
    entity: z.string().min(1).optional(),
  })
  .passthrough();

const StatePayload = z
  .object({
    v: z.number().int(),
    ts: z.number().finite(),
    entity: z.string().optional(),
    item: z.string().optional(),
    value: z.unknown(),
  })
  .passthrough();

const TopologyDoc = z
  .object({
    service: z.string(),
    version: z.string().optional().default(''),
    entities: z
      .array(
        z
          .object({
            id: z.string(),
            kind: z.string(),
            row: z.number().int().optional(),
            col: z.number().int().optional(),
            lat: z.number().optional(),
            lon: z.number().optional(),
          })
          .passthrough(),
      )
      .default([]),
    streams: z
      .array(
        z
          .object({
            topic: z.string(),
            entity_kinds: z.array(z.string()).default([]),
            period_s: z.number().positive().nullable().optional(),
            fields: z
              .array(
                z
                  .object({
                    key: z.string(),
                    type: z.string(),
                    unit: z.string().optional(),
                    values: z.array(z.string()).optional(),
                  })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
    state: z
      .array(z.object({ topic: z.string(), type: z.string(), unit: z.string().optional() }).passthrough())
      .default([]),
    events: z.array(z.object({ topic: z.string() }).passthrough()).default([]),
    controls: z
      .array(
        z
          .object({
            topic: z.string(),
            entity_kinds: z.array(z.string()).default([]),
            value: z.record(z.unknown()).default({}),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const lastSeg = (topic: string) => topic.split('/').pop() ?? topic;

export function parseTopologyDoc(doc: unknown): ServiceTopology | null {
  const r = TopologyDoc.safeParse(doc);
  if (!r.success) return null;
  const d = r.data;
  return {
    service: d.service,
    version: d.version,
    entities: d.entities.map((e) => ({
      id: e.id,
      kind: e.kind,
      ...(e.row !== undefined ? { row: e.row } : {}),
      ...(e.col !== undefined ? { col: e.col } : {}),
      ...(e.lat !== undefined ? { lat: e.lat } : {}),
      ...(e.lon !== undefined ? { lon: e.lon } : {}),
    })),
    streams: d.streams.map((s) => ({
      topic: s.topic,
      name: lastSeg(s.topic),
      entityKinds: s.entity_kinds,
      periodS: s.period_s ?? null,
      fields: s.fields.map((f) => ({
        key: f.key,
        type: f.type,
        ...(f.unit !== undefined ? { unit: f.unit } : {}),
        ...(f.values !== undefined ? { values: f.values } : {}),
      })),
    })),
    state: d.state.map((s) => ({
      topic: s.topic,
      item: lastSeg(s.topic),
      type: s.type,
      ...(s.unit !== undefined ? { unit: s.unit } : {}),
    })),
    events: d.events.map((e) => lastSeg(e.topic)),
    controls: d.controls.map((c) => ({
      topic: c.topic,
      control: lastSeg(c.topic),
      entityKinds: c.entity_kinds,
      value: c.value,
    })),
  };
}

function json(payload: Buffer | string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Pure: same input, same output. Never throws. */
export function parseMessage(topic: string, payload: Buffer | string, recvTs: number, retained = false): Parsed {
  const info = classifyTopic(topic);
  const service = info.service ?? '';
  const base: ParsedBase = { service, topic, recvTs, retained };
  const invalid = (reason: string, entity: string | null = null, simTs: number | null = null): ParsedInvalid => ({
    ...base,
    kind: 'invalid',
    entity,
    simTs,
    reason,
  });
  const empty = payload.length === 0;

  switch (info.kind) {
    case 'unknown':
      return invalid('unknown_topic');
    case 'topology': {
      if (empty) return invalid('topology_removed', 'global');
      const j = json(payload);
      if (!j.ok) return invalid('bad_json', 'global');
      const topology = parseTopologyDoc(j.value);
      if (!topology) return invalid('bad_topology', 'global');
      return { ...base, kind: 'topology', entity: 'global', simTs: null, topology };
    }
    case 'state': {
      if (empty) {
        return { ...base, kind: 'state', entity: info.entity, item: info.item, simTs: null, value: null, removed: true };
      }
      const j = json(payload);
      if (!j.ok) return invalid('bad_json', info.entity);
      const s = StatePayload.safeParse(j.value);
      if (!s.success) return invalid('bad_state', info.entity);
      return {
        ...base,
        kind: 'state',
        entity: info.entity,
        item: info.item,
        simTs: s.data.ts,
        value: s.data.value ?? null,
        removed: false,
      };
    }
    case 'telemetry': {
      if (empty) return invalid('empty', info.entity);
      const j = json(payload);
      if (!j.ok) return invalid('bad_json', info.entity);
      const e = Envelope.safeParse(j.value);
      if (!e.success) return invalid('bad_envelope', info.entity);
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(e.data)) if (!ENVELOPE_KEYS.has(k)) fields[k] = v;
      return {
        ...base,
        kind: 'telemetry',
        entity: e.data.entity ?? info.entity,
        stream: info.stream,
        simTs: e.data.ts,
        seq: e.data.seq ?? null,
        fields,
        backfill: fields['backfill'] === true,
      };
    }
    case 'event': {
      if (empty) return invalid('empty');
      const j = json(payload);
      if (!j.ok) return invalid('bad_json');
      const e = Envelope.safeParse(j.value);
      if (!e.success) return invalid('bad_envelope');
      return {
        ...base,
        kind: 'event',
        entity: e.data.entity ?? 'global',
        event: info.event,
        simTs: e.data.ts,
        seq: e.data.seq ?? null,
        body: e.data as Record<string, unknown>,
      };
    }
    case 'ack': {
      const j = json(payload);
      if (!j.ok || typeof j.value !== 'object' || j.value === null) return invalid('bad_json');
      const body = j.value as Record<string, unknown>;
      const ts = typeof body['ts'] === 'number' ? body['ts'] : null;
      const target = typeof body['target'] === 'string' ? body['target'] : 'global';
      return { ...base, kind: 'ack', entity: target, commandId: info.commandId, simTs: ts, body };
    }
    case 'cmd': {
      const j = json(payload);
      if (!j.ok || typeof j.value !== 'object' || j.value === null) return invalid('bad_json', info.entity);
      return {
        ...base,
        kind: 'cmd',
        entity: info.entity,
        control: info.control,
        simTs: null,
        body: j.value as Record<string, unknown>,
      };
    }
  }
}
