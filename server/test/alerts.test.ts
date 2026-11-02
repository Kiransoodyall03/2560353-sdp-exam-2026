import { describe, expect, it } from 'vitest';
import type { AlertService } from '../../shared/types.js';
import { parseCsv } from '../src/alerts/backlog.js';
import { publicAlert, publicEvent } from '../src/alerts/public.js';
import { AlertStore } from '../src/alerts/store.js';
import { AlertWorkflow, decodeAlertId, parseAlertPayload, type AlertPayload } from '../src/alerts/workflow.js';
import { fixture, memDb } from './helpers.js';

const researcher = { code: 'arl-as3', name: 'Person A' };

function setup() {
  const db = memDb();
  const store = new AlertStore(db, () => 1000);
  const wf = new AlertWorkflow(store);
  const actions: string[] = [];
  wf.onChange((c) => actions.push(c.action));
  return { db, store, wf, actions };
}

const raise = (over: Partial<AlertPayload> = {}): AlertPayload =>
  parseAlertPayload({
    alert_id: 'rta-dish_temperature-dish-007-0001',
    type: 'dish_temperature',
    severity: 'warning',
    state: 'raised',
    entity: 'dish-007',
    value: 331,
    limit: 330,
    unit: 'K',
    message: 'Dish temperature high',
    metadata: {},
    ts: 100,
    ...over,
  })!;

describe('real alert fixtures', () => {
  it('parse and ingest under (service, alert_id)', () => {
    const { store, wf } = setup();
    let n = 0;
    for (const { topic, payload } of fixture('alerts.txt')) {
      if (!topic.endsWith('/events/alert')) continue;
      const p = parseAlertPayload(JSON.parse(payload));
      expect(p, payload).not.toBeNull();
      wf.ingest(topic.split('/')[1] as AlertService, p!);
      n++;
    }
    expect(n).toBeGreaterThan(200);
    const s = store.summary();
    expect(s.open).toBeGreaterThan(0);
    expect(Object.keys(s.byService).sort()).toEqual(expect.arrayContaining(['rta']));
  });
});

describe('AlertWorkflow', () => {
  it('raises once and ignores duplicate raises', () => {
    const { store, wf, actions } = setup();
    wf.ingest('rta', raise());
    expect(wf.ingest('rta', raise())).toBeNull();
    expect(actions).toEqual(['raised']);
    expect(store.get('rta', 'rta-dish_temperature-dish-007-0001')).toMatchObject({
      svcState: 'raised',
      opState: 'unacked',
      value: 331,
      limit: 330,
      unit: 'K',
      raisedTs: 100,
    });
  });

  it('escalates under the same id, keeps max severity and re-opens an acknowledged alert', () => {
    const { store, wf } = setup();
    wf.ingest('rta', raise());
    expect(wf.acknowledge('rta', 'rta-dish_temperature-dish-007-0001', researcher, null, 110).ok).toBe(true);
    wf.ingest('rta', raise({ severity: 'critical', value: 340, ts: 120 }));
    const a = store.get('rta', 'rta-dish_temperature-dish-007-0001')!;
    expect(a).toMatchObject({ severity: 'critical', maxSeverity: 'critical', opState: 'unacked', value: 340 });
    expect(store.events('rta', a.alertId).map((e) => e.action)).toEqual(['raised', 'acked', 'reopened', 'escalated']);
    wf.ingest('rta', raise({ severity: 'warning', value: 335, ts: 130 }));
    expect(store.get('rta', a.alertId)).toMatchObject({ severity: 'warning', maxSeverity: 'critical' });
  });

  it('keeps a cleared alert on the annunciator until it is resolved', () => {
    const { store, wf } = setup();
    wf.ingest('rta', raise());
    wf.ingest('rta', raise({ state: 'cleared', ts: 200 }));
    const a = store.get('rta', 'rta-dish_temperature-dish-007-0001')!;
    expect(a).toMatchObject({ svcState: 'cleared', opState: 'unacked', clearedTs: 200 });
    expect(store.openAlerts().map((x) => x.key)).toContain(a.key);
  });

  it('requires acknowledgement before resolve, and a note to resolve', () => {
    const { store, wf } = setup();
    wf.ingest('rta', raise());
    const id = 'rta-dish_temperature-dish-007-0001';
    expect(wf.resolve('rta', id, researcher, 'fixed it', 150)).toMatchObject({ ok: false, code: 'not_acked' });
    expect(wf.acknowledge('rta', id, researcher, '  checking  ', 150)).toMatchObject({ ok: true });
    expect(wf.acknowledge('rta', id, researcher, null, 151)).toMatchObject({ ok: false, code: 'already_acked' });
    expect(wf.resolve('rta', id, researcher, ' x ', 160)).toMatchObject({ ok: false, code: 'note_required' });
    const r = wf.resolve('rta', id, researcher, 'Cooled after slew; no damage.', 170);
    expect(r.ok).toBe(true);
    const a = store.get('rta', id)!;
    expect(a).toMatchObject({
      opState: 'resolved',
      ackBy: 'arl-as3',
      ackName: 'Person A',
      ackNote: 'checking',
      resolvedBy: 'arl-as3',
      resolutionNote: 'Cooled after slew; no damage.',
    });
    expect(store.openAlerts()).toHaveLength(0);
    expect(store.events('rta', id).map((e) => e.action)).toEqual(['raised', 'acked', 'resolved']);
  });

  it('re-opens a resolved alert when the service raises it again', () => {
    const { store, wf } = setup();
    const id = 'rta-dish_temperature-dish-007-0001';
    wf.ingest('rta', raise());
    wf.ingest('rta', raise({ state: 'cleared', ts: 110 }));
    wf.acknowledge('rta', id, researcher, null, 120);
    wf.resolve('rta', id, researcher, 'handled', 130);
    wf.ingest('rta', raise({ ts: 200 }));
    expect(store.get('rta', id)).toMatchObject({ opState: 'unacked', svcState: 'raised', raisedTs: 200, resolvedBy: null });
  });

  it('keeps the audit trail append-only', () => {
    const { db, wf } = setup();
    wf.ingest('rta', raise());
    expect(() => db.prepare(`UPDATE alert_events SET action = 'x'`).run()).toThrow();
    expect(() => db.prepare(`DELETE FROM alert_events`).run()).toThrow();
  });

  it('reconciles retained active_alerts: placeholders for unseen ids, clears for missing ones', () => {
    const { store, wf } = setup();
    wf.ingest('rta', raise());
    const changes = wf.reconcile('rta', ['rta-availability-global-0003'], 500);
    expect(changes.map((c) => c.action).sort()).toEqual(['cleared_by_reconcile', 'reconciled_placeholder']);
    expect(store.get('rta', 'rta-availability-global-0003')).toMatchObject({
      placeholder: true,
      type: 'availability',
      entity: 'global',
      severity: 'critical', // spec default for availability
      svcState: 'raised',
    });
    expect(store.get('rta', 'rta-dish_temperature-dish-007-0001')).toMatchObject({ svcState: 'cleared', clearedTs: 500 });
  });

  it('fills a placeholder from the API backlog and labels the source', () => {
    const { store, wf } = setup();
    wf.reconcile('rta', ['rta-dish_scan-dish-020-0002'], 500);
    const ok = wf.fillFromBacklog(
      'rta',
      raise({ alert_id: 'rta-dish_scan-dish-020-0002', type: 'dish_scan', entity: 'dish-020', severity: 'info', ts: 50 }),
    );
    expect(ok).toBe(true);
    const a = store.get('rta', 'rta-dish_scan-dish-020-0002')!;
    expect(a).toMatchObject({ placeholder: false, severity: 'info', maxSeverity: 'info', raisedTs: 50 });
    expect(a.metadata).toMatchObject({ details_source: 'api_backlog', raised_before_capture: true });
  });

  it('raises, escalates and clears platform alerts with a stable id per occurrence', () => {
    const { store, wf } = setup();
    const spec = { subject: 'rta', type: 'stream_silent', severity: 'warning' as const, message: 'silent' };
    const first = wf.raisePlatform(spec, 10)!;
    expect(first.alert.alertId).toBe('platform-rta-stream_silent-0001');
    wf.raisePlatform({ ...spec, severity: 'critical' }, 20);
    expect(store.get('platform', 'platform-rta-stream_silent-0001')).toMatchObject({ severity: 'critical' });
    wf.clearPlatform('rta', 'stream_silent', 30);
    expect(store.get('platform', 'platform-rta-stream_silent-0001')).toMatchObject({ svcState: 'cleared' });
    // a new occurrence after clear + resolve gets the next id
    wf.acknowledge('platform', 'platform-rta-stream_silent-0001', researcher, null, 31);
    wf.resolve('platform', 'platform-rta-stream_silent-0001', researcher, 'stream back', 32);
    expect(wf.raisePlatform(spec, 40)!.alert.alertId).toBe('platform-rta-stream_silent-0002');
  });
});

describe('alert helpers', () => {
  it('decodes alert ids into type and entity', () => {
    expect(decodeAlertId('rta', 'rta-dish_calibration-dish-002-0001')).toEqual({ type: 'dish_calibration', entity: 'dish-002' });
    expect(decodeAlertId('lwm', 'lwm-high_wind-lwm-3-0004')).toEqual({ type: 'high_wind', entity: 'lwm-3' });
    expect(decodeAlertId('rta', 'rta-availability-global-0001')).toEqual({ type: 'availability', entity: 'global' });
  });

  it('masks researcher codes on the wire', () => {
    const { store, wf } = setup();
    wf.ingest('rta', raise());
    const r = wf.acknowledge('rta', 'rta-dish_temperature-dish-007-0001', researcher, null, 1);
    if (!r.ok) throw new Error('ack failed');
    expect(publicAlert(r.alert)).toMatchObject({ ackBy: 'arl***', ackName: 'Person A' });
    const ev = store.events('rta', r.alert.alertId).find((e) => e.action === 'acked')!;
    expect(publicEvent(ev).actor).toBe('arl***');
    expect(JSON.stringify(publicAlert(r.alert))).not.toContain('arl-as3');
  });

  it('parses backlog CSV with quoted JSON payloads', () => {
    const csv = 'ts,entity,kind,payload\r\n1,dish-001,alert,"{""alert_id"":""a-1"",""msg"":""x, y""}"\n2,global,alert,""\n';
    expect(parseCsv(csv)).toEqual([
      ['ts', 'entity', 'kind', 'payload'],
      ['1', 'dish-001', 'alert', '{"alert_id":"a-1","msg":"x, y"}'],
      ['2', 'global', 'alert', ''],
    ]);
  });
});
