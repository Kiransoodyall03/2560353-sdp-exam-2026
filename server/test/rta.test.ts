import { describe, expect, it } from 'vitest';
import type { Parsed } from '../src/core/parse.js';
import { emptyRtaState, newDelta, reduceRta, scanProgress, type RtaState } from '../src/plugins/rta/model.js';
import { parseRta, toScanSample, type ScanFields } from '../src/plugins/rta/parse.js';
import { fixture } from './helpers.js';

const parseAll = (name: string, filter: (topic: string) => boolean = () => true): Parsed[] =>
  fixture(name)
    .filter((l) => filter(l.topic))
    .flatMap((l) => parseRta(l.topic, l.payload, 1, l.topic.includes('/state/')));

describe('parseRta on real fixtures', () => {
  it('validates normal and scan telemetry fields', () => {
    const ps = parseAll('rta-telemetry.txt');
    expect(ps.length).toBe(520);
    expect(ps.filter((p) => p.kind === 'invalid')).toEqual([]);
    const normal = ps.find((p) => p.kind === 'telemetry' && p.stream === 'normal');
    expect(normal).toMatchObject({ kind: 'telemetry', service: 'rta' });
    const scans = ps.filter((p) => p.kind === 'telemetry' && p.stream === 'scan');
    expect(scans.length).toBe(400);
    // a measurement that cannot be taken is null (spec), otherwise a number
    for (const p of scans) {
      const v = p.kind === 'telemetry' ? p.fields['pointing_offset_ra_rad'] : undefined;
      expect(v === null || typeof v === 'number').toBe(true);
    }
    expect(scans.some((p) => p.kind === 'telemetry' && typeof p.fields['pointing_offset_ra_rad'] === 'number')).toBe(true);
  });

  it('validates every RTA state item and scan event', () => {
    for (const p of [...parseAll('rta-state.txt'), ...parseAll('rta-events.txt', (t) => t.endsWith('/events/scan'))]) {
      expect(p.kind, p.topic).not.toBe('invalid');
    }
  });

  it('rejects wrongly typed fields as invalid (the raw row is still stored)', () => {
    const [p] = parseRta('arl/rta/dish-001/telemetry/normal', JSON.stringify({ v: 1, ts: 1, seq: 0, power_w: 'lots' }), 1);
    expect(p).toMatchObject({ kind: 'invalid', reason: 'bad_normal_fields' });
    const [s] = parseRta('arl/rta/main/state/members', JSON.stringify({ v: 1, ts: 1, value: 'dish-001' }), 1);
    expect(s).toMatchObject({ kind: 'invalid', reason: 'bad_state_members' });
  });

  it('turns scan telemetry into image samples and skips null measurements', () => {
    const ps = parseAll('rta-telemetry.txt', (t) => t.endsWith('/telemetry/scan'));
    const samples = ps.flatMap((p) => (p.kind === 'telemetry' ? [toScanSample(p.entity, p.simTs, p.fields as ScanFields)] : []));
    const usable = samples.filter((s) => s !== null);
    expect(usable.length).toBeGreaterThan(0);
    for (const s of usable) {
      expect(s!.scanId).toMatch(/^scan-/);
      expect(Number.isFinite(s!.dra) && Number.isFinite(s!.ddec) && Number.isFinite(s!.signal)).toBe(true);
    }
    expect(toScanSample('dish-001', 1, { scan_id: 'scan-1', pointing_offset_ra_rad: null } as ScanFields)).toBeNull();
  });
});

describe('reduceRta (replayable fold)', () => {
  function fold(): { s: RtaState; ended: Set<string>; samples: number } {
    const s = emptyRtaState();
    const ended = new Set<string>();
    let samples = 0;
    const stream = [
      ...parseAll('topology.txt', (t) => t === 'arl/rta/$topology'),
      ...parseAll('rta-state.txt'),
      ...parseAll('rta-events.txt', (t) => t.endsWith('/events/scan')),
      ...parseAll('rta-telemetry.txt'),
    ];
    for (const p of stream) {
      const d = newDelta();
      reduceRta(s, p, d);
      for (const id of d.endedScans) ended.add(id);
      samples += d.samples.length;
    }
    return { s, ended, samples };
  }

  it('builds dishes from $topology and state', () => {
    const { s } = fold();
    expect(Object.keys(s.dishes)).toHaveLength(100);
    expect(s.dishes['dish-011']).toMatchObject({ row: 1, col: 0 });
    expect(s.subarrays['main']).toBeDefined();
  });

  it('records scan geometry from the started event and ends it on completed', () => {
    const { s, ended } = fold();
    const scan = s.scans['scan-0001']!;
    expect(scan).toMatchObject({ gridSize: 128, overlap: 3, fovRad: 0.01, geometryFromEvent: true, status: 'completed' });
    expect(scan.dishes).toHaveLength(80);
    expect(scan.bandHz).toBe(1.42e9);
    expect(ended.has('scan-0001')).toBe(true);
    expect(scan.events.map((e) => e.event)).toContain('completed');
  });

  it('counts scan samples and per-dish progress', () => {
    const { s, samples } = fold();
    expect(samples).toBeGreaterThan(0);
    const total = Object.values(s.scans).reduce((a, sc) => a + sc.samples, 0);
    expect(total).toBe(samples);
    const withProgress = Object.values(s.scans).find((sc) => Object.keys(sc.progress).length > 0)!;
    const p = scanProgress(withProgress);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThanOrEqual(0);
    expect(p!).toBeLessThanOrEqual(1);
  });

  it('is deterministic: folding the same messages twice gives the same state', () => {
    expect(fold().s).toEqual(fold().s);
  });

  it('tracks wind stow start time and clears it', () => {
    const s = emptyRtaState();
    const st = (value: boolean, ts: number) =>
      parseRta('arl/rta/global/state/wind_stow', JSON.stringify({ v: 1, ts, entity: 'global', item: 'wind_stow', value }), 1)[0]!;
    reduceRta(s, st(true, 100), newDelta());
    reduceRta(s, st(true, 200), newDelta());
    expect(s.global).toMatchObject({ windStow: true, windStowSinceTs: 100 });
    reduceRta(s, st(false, 300), newDelta());
    expect(s.global).toMatchObject({ windStow: false, windStowSinceTs: null });
  });
});
