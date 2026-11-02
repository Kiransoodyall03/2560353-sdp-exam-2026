import { describe, expect, it } from 'vitest';
import { parseMessage, type Parsed } from '../src/core/parse.js';
import { BatchWriter, genericPersister, type RawRow } from '../src/db/writer.js';
import { fixture, memDb } from './helpers.js';

function rawOf(topic: string, payload: string, p: Parsed): RawRow {
  return { simTs: p.simTs, recvTs: 1, service: p.service, entity: p.entity, kind: p.kind, topic, payload, retained: false };
}

const lines = fixture('rta-telemetry.txt').slice(0, 10);
const count = (db: ReturnType<typeof memDb>, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('BatchWriter', () => {
  it('writes raw rows and typed rows in one transaction', () => {
    const db = memDb();
    const w = new BatchWriter(db, [genericPersister()], { flushRows: 1000 });
    for (const l of lines) {
      const p = parseMessage(l.topic, l.payload, 1);
      w.enqueue(rawOf(l.topic, l.payload, p), [p]);
    }
    expect(w.stats.queueDepth).toBe(10);
    expect(w.flush()).toBe(10);
    expect(count(db, 'raw_messages')).toBe(10);
    expect(count(db, 'telemetry')).toBe(10);
    expect(w.stats).toMatchObject({ written: 10, queueDepth: 0, degraded: false, dropped: 0 });
  });

  it('keeps raw only past capacity and drops past the hard cap (degraded)', () => {
    const db = memDb();
    const changes: boolean[] = [];
    const w = new BatchWriter(db, [genericPersister()], { capacity: 5, hardCapacity: 8, flushRows: 1000 });
    w.onDegradedChange = (d) => changes.push(d);
    for (const l of lines) {
      const p = parseMessage(l.topic, l.payload, 1);
      w.enqueue(rawOf(l.topic, l.payload, p), [p]);
    }
    expect(w.stats).toMatchObject({ rawOnly: 3, dropped: 2, degraded: true });
    expect(changes).toEqual([true]);
    w.flush();
    expect(count(db, 'raw_messages')).toBe(8);
    expect(count(db, 'telemetry')).toBe(5);
  });

  it('still stores raw rows when a typed persister fails', () => {
    const db = memDb();
    const errors: unknown[] = [];
    const w = new BatchWriter(db, [genericPersister(), () => {
      throw new Error('plugin persist failed');
    }]);
    w.onError = (e) => errors.push(e);
    for (const l of lines.slice(0, 3)) {
      const p = parseMessage(l.topic, l.payload, 1);
      w.enqueue(rawOf(l.topic, l.payload, p), [p]);
    }
    w.flush();
    expect(errors).toHaveLength(1);
    expect(count(db, 'raw_messages')).toBe(3);
    expect(count(db, 'telemetry')).toBe(0); // rolled back with the failing persister
    expect(w.stats).toMatchObject({ errors: 1, rawOnly: 3, written: 3 });
  });

  it('stores invalid messages as raw rows (parsed = null)', () => {
    const db = memDb();
    const w = new BatchWriter(db, [genericPersister()]);
    const p = parseMessage('arl/rta/dish-001/telemetry/normal', '{broken', 1);
    w.enqueue(rawOf('arl/rta/dish-001/telemetry/normal', '{broken', p), null);
    w.flush();
    expect(db.prepare('SELECT kind, payload FROM raw_messages').get()).toEqual({ kind: 'invalid', payload: '{broken' });
  });
});
