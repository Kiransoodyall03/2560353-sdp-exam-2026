import { describe, expect, it } from 'vitest';
import { parseMessage, parseTopologyDoc } from '../src/core/parse.js';
import { classifyTopic } from '../src/core/topics.js';
import { ALL_FIXTURES, fixture } from './helpers.js';

describe('classifyTopic (documented layout)', () => {
  it('classifies each topic kind', () => {
    expect(classifyTopic('arl/rta/$topology')).toEqual({ kind: 'topology', service: 'rta' });
    expect(classifyTopic('arl/rta/dish-001/telemetry/scan')).toEqual({
      kind: 'telemetry',
      service: 'rta',
      entity: 'dish-001',
      stream: 'scan',
    });
    expect(classifyTopic('arl/rta/main/state/scan_state')).toEqual({
      kind: 'state',
      service: 'rta',
      entity: 'main',
      item: 'scan_state',
    });
    expect(classifyTopic('arl/lwm/events/alert')).toEqual({ kind: 'event', service: 'lwm', event: 'alert' });
    expect(classifyTopic('arl/rta/cmd/main/start_scan')).toEqual({
      kind: 'cmd',
      service: 'rta',
      entity: 'main',
      control: 'start_scan',
    });
    expect(classifyTopic('arl/rta/ack/c-1')).toEqual({ kind: 'ack', service: 'rta', commandId: 'c-1' });
  });

  it('rejects topics outside the layout', () => {
    expect(classifyTopic('other/rta/$topology').kind).toBe('unknown');
    expect(classifyTopic('arl/rta/dish-001/telemetry').kind).toBe('unknown');
    expect(classifyTopic('arl/rta/dish-001/telemetry/scan/extra').kind).toBe('unknown');
  });

  it('classifies every topic in the real fixtures', () => {
    for (const name of ALL_FIXTURES) {
      for (const { topic } of fixture(name)) expect(classifyTopic(topic).kind, topic).not.toBe('unknown');
    }
  });
});

describe('parseMessage', () => {
  it('parses every real fixture line without an invalid result', () => {
    for (const name of ALL_FIXTURES) {
      for (const { topic, payload } of fixture(name)) {
        const p = parseMessage(topic, payload, 1, false);
        expect(p.kind, `${topic} ${p.kind === 'invalid' ? p.reason : ''}`).not.toBe('invalid');
      }
    }
  });

  it('separates the envelope from measurement fields', () => {
    const line = fixture('rta-telemetry.txt').find((l) => l.topic.endsWith('/telemetry/normal'))!;
    const p = parseMessage(line.topic, line.payload, 1);
    expect(p.kind).toBe('telemetry');
    if (p.kind !== 'telemetry') return;
    const body = JSON.parse(line.payload) as Record<string, unknown>;
    expect(p.simTs).toBe(body['ts']);
    expect(p.seq).toBe(body['seq']);
    expect(p.entity).toBe(body['entity']);
    expect(p.fields).not.toHaveProperty('ts');
    expect(p.fields).not.toHaveProperty('seq');
    expect(p.fields).toHaveProperty('temperature_k');
    expect(p.backfill).toBe(false);
  });

  it('flags LWM backfill samples', () => {
    const line = fixture('lwm-opg.txt').find((l) => l.topic.endsWith('/telemetry/weather'))!;
    const body = { ...(JSON.parse(line.payload) as object), backfill: true };
    const p = parseMessage(line.topic, JSON.stringify(body), 1);
    expect(p.kind === 'telemetry' && p.backfill).toBe(true);
  });

  it('treats an empty retained state payload as removal', () => {
    const p = parseMessage('arl/rta/obs-2/state/members', '', 1, true);
    expect(p).toMatchObject({ kind: 'state', entity: 'obs-2', item: 'members', removed: true, value: null });
  });

  it('reports malformed payloads instead of throwing', () => {
    expect(parseMessage('arl/rta/dish-001/telemetry/normal', '{oops', 1)).toMatchObject({ kind: 'invalid', reason: 'bad_json' });
    expect(parseMessage('arl/rta/dish-001/telemetry/normal', '{"ts":"x"}', 1)).toMatchObject({
      kind: 'invalid',
      reason: 'bad_envelope',
    });
    expect(parseMessage('arl/rta/main/state/scan_state', '[]', 1)).toMatchObject({ kind: 'invalid', reason: 'bad_state' });
    expect(parseMessage('nope', '{}', 1)).toMatchObject({ kind: 'invalid', reason: 'unknown_topic' });
  });

  it('is pure: same input, same output', () => {
    for (const { topic, payload } of fixture('rta-state.txt').slice(0, 20)) {
      expect(parseMessage(topic, Buffer.from(payload), 5, true)).toEqual(parseMessage(topic, payload, 5, true));
    }
  });
});

describe('parseTopologyDoc', () => {
  const docs = new Map(
    fixture('topology.txt').map((l) => [l.topic.split('/')[1]!, parseTopologyDoc(JSON.parse(l.payload))]),
  );

  it('reads $topology for rta, lwm and opg', () => {
    expect([...docs.keys()].sort()).toEqual(['lwm', 'opg', 'rta']);
    for (const t of docs.values()) expect(t).not.toBeNull();
  });

  it('keeps the RTA entities, stream periods and controls', () => {
    const t = docs.get('rta')!;
    const dishes = t.entities.filter((e) => e.kind === 'dish');
    expect(dishes).toHaveLength(100);
    expect(dishes[0]).toMatchObject({ id: 'dish-001', row: 0, col: 0 });
    expect(t.entities.some((e) => e.kind === 'subarray' && e.id === 'main')).toBe(true);
    const period = Object.fromEntries(t.streams.map((s) => [s.name, s.periodS]));
    expect(period).toEqual({ normal: 120, scan: 1 });
    expect(t.controls.map((c) => c.control)).toContain('start_scan');
    expect(t.events).toEqual(['alert', 'scan']);
  });
});
