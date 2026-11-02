import { describe, expect, it } from 'vitest';
import { SeqTracker } from '../src/core/seq-tracker.js';

const T = 'arl/lwm/lwm-1/telemetry/weather';

describe('SeqTracker', () => {
  it('counts no gap for consecutive sequence numbers', () => {
    const s = new SeqTracker(() => 0);
    for (let i = 0; i < 5; i++) expect(s.observe('lwm', T, i, false)).toEqual({ gap: 0, filled: 0, restart: false });
    expect(s.stats('lwm')).toMatchObject({ total: 0, outstanding: 0 });
  });

  it('detects a gap and records the missing sequence numbers', () => {
    const s = new SeqTracker(() => 42);
    s.observe('lwm', T, 0, false);
    expect(s.observe('lwm', T, 4, false).gap).toBe(3);
    expect(s.stats('lwm')).toEqual({ total: 3, outstanding: 3, lastGapWallTs: 42 });
    expect(s.gapTopics('lwm')).toEqual([{ topic: T, missing: 3 }]);
  });

  it('fills a gap when backfill re-publishes the missing samples', () => {
    const s = new SeqTracker();
    s.observe('lwm', T, 10, false);
    s.observe('lwm', T, 14, false);
    expect(s.observe('lwm', T, 12, true).filled).toBe(1);
    expect(s.observe('lwm', T, 11, true).filled).toBe(1);
    expect(s.observe('lwm', T, 13, true).filled).toBe(1);
    expect(s.stats('lwm').outstanding).toBe(0);
    // an old backfill sample that was never missing is ignored
    expect(s.observe('lwm', T, 3, true)).toEqual({ gap: 0, filled: 0, restart: false });
  });

  it('treats a reset to 0 or a large step back as a service restart', () => {
    const s = new SeqTracker();
    s.observe('rta', 'arl/rta/dish-001/telemetry/normal', 500, false);
    expect(s.observe('rta', 'arl/rta/dish-001/telemetry/normal', 0, false).restart).toBe(true);
    s.observe('rta', 'arl/rta/dish-002/telemetry/normal', 500, false);
    expect(s.observe('rta', 'arl/rta/dish-002/telemetry/normal', 480, false).restart).toBe(true);
    // a small step back is a duplicate / reorder, not a restart
    s.observe('rta', 'arl/rta/dish-003/telemetry/normal', 500, false);
    expect(s.observe('rta', 'arl/rta/dish-003/telemetry/normal', 499, false).restart).toBe(false);
  });

  it('ignores messages without seq (state)', () => {
    const s = new SeqTracker();
    expect(s.observe('rta', 'arl/rta/main/state/scan_state', null, false)).toEqual({ gap: 0, filled: 0, restart: false });
  });
});
