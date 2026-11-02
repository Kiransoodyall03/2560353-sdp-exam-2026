// P4: target-elevation astronomy, RTA safeguards, ack state transitions and the 30 s timeout.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { explainCommandReason } from '../../shared/commands.js';
import type { CommandSpec } from '../src/commands/types.js';
import { AckTracker } from '../src/commands/acks.js';
import type { ParsedAck } from '../src/core/parse.js';
import { commandDTO, getCommandRow, insertCommand } from '../src/db/commands.js';
import { altitudeDeg, lstRad } from '../src/plugins/rta/astro.js';
import { rtaCommandSpecs, rtaPresets, type RtaControlView } from '../src/plugins/rta/controls.js';
import type { RtaDish, RtaState } from '../src/plugins/rta/model.js';
import { memDb } from './helpers.js';

const DEG = Math.PI / 180;
const T = 1_793_645_293_000;
const LAT = -31.2;
const LON = 21.7;

// ------------------------------------------------------------------ astro
describe('astro', () => {
  it('puts the celestial pole at the site latitude', () => {
    expect(altitudeDeg(0, 90 * DEG, LAT, LON, T)).toBeCloseTo(LAT, 6);
    expect(altitudeDeg(1.3, -90 * DEG, LAT, LON, T)).toBeCloseTo(-LAT, 6);
  });

  it('puts a position at the zenith when RA equals LST and Dec equals latitude', () => {
    const lst = lstRad(T, LON);
    expect(altitudeDeg(lst, LAT * DEG, LAT, LON, T)).toBeCloseTo(90, 6);
  });

  it('drops a position 12 h away in RA below the horizon', () => {
    const lst = lstRad(T, LON);
    expect(altitudeDeg(lst + Math.PI, LAT * DEG, LAT, LON, T)).toBeLessThan(0);
  });
});

// ------------------------------------------------------------- RTA state
function dish(id: string, over: Partial<RtaDish> = {}): RtaDish {
  return {
    id,
    row: 0,
    col: 0,
    lat: LAT,
    lon: LON,
    normal: null,
    scan: null,
    lastTs: null,
    lastStream: null,
    commanded: null,
    subarray: 'main',
    lastCalibration: null,
    enabled: true,
    stowed: false,
    snr: null,
    ...over,
  };
}

function rtaState(over: { activeDishes?: number; windStow?: boolean; scanState?: string; target?: string | null } = {}): RtaState {
  return {
    dishes: {
      'dish-001': dish('dish-001'),
      'dish-002': dish('dish-002'),
      'dish-003': dish('dish-003'),
      'dish-004': dish('dish-004', { stowed: true }),
    },
    subarrays: {
      main: {
        id: 'main',
        members: ['dish-001', 'dish-002', 'dish-003'],
        scanState: over.scanState ?? 'idle',
        target: over.target === undefined ? 'tgt-up' : over.target,
        observationFrequency: 1.42e9,
        nextScan: null,
        scanId: null,
        updatedTs: null,
      },
    },
    scans: {},
    global: { activeDishes: over.activeDishes ?? 90, windStow: over.windStow ?? false, windStowSinceTs: null },
  };
}

/** tgt-up sits at the zenith; tgt-down is 12 h away in RA, well below the horizon. */
function view(state: RtaState): RtaControlView {
  const lst = lstRad(T, LON);
  return {
    state,
    simNow: () => T,
    resolveTarget: (id) =>
      id === 'tgt-up'
        ? { ra_rad: lst, dec_rad: LAT * DEG, fov_rad: 0.01 }
        : id === 'tgt-down'
          ? { ra_rad: lst + Math.PI, dec_rad: LAT * DEG, fov_rad: 0.01 }
          : null,
    hasTarget: (id) => id !== 'tgt-missing',
    site: () => ({ lat: LAT, lon: LON }),
    minActive: () => 80,
  };
}

const specOf = (s: RtaControlView, control: string): CommandSpec => {
  const s2 = rtaCommandSpecs(s).find((x) => x.control === control);
  if (!s2) throw new Error(`no spec ${control}`);
  return s2;
};

const guard = (s: RtaControlView, control: string, entity: string, value: unknown) =>
  specOf(s, control).guard?.({ service: 'rta', entity, value, ctx: {} as never }) ?? null;

const confirm = (s: RtaControlView, control: string, entity: string, value: unknown) =>
  specOf(s, control).confirm?.({ service: 'rta', entity, value, ctx: {} as never }) ?? null;

describe('RTA safeguards', () => {
  it('refuses to start a scan while wind stow is engaged', () => {
    const b = guard(view(rtaState({ windStow: true })), 'start_scan', 'main', true);
    expect(b?.code).toBe('wind_stow');
  });

  it('refuses to start a scan when the target is below 15°', () => {
    const b = guard(view(rtaState({ target: 'tgt-down' })), 'start_scan', 'main', true);
    expect(b?.code).toBe('target_elevation');
    expect(b?.message).toMatch(/15°/);
  });

  it('allows a scan of a target high in the sky', () => {
    expect(guard(view(rtaState({ target: 'tgt-up' })), 'start_scan', 'main', true)).toBeNull();
  });

  it('refuses to start a scan with fewer than 3 dishes in service', () => {
    const s = rtaState();
    s.dishes['dish-002']!.enabled = false;
    s.dishes['dish-003']!.enabled = false;
    expect(guard(view(s), 'start_scan', 'main', true)?.code).toBe('too_few_dishes');
  });

  it('refuses a target change while scanning, and allows it when idle', () => {
    expect(guard(view(rtaState({ scanState: 'running' })), 'set_target', 'main', 'tgt-up')?.code).toBe('scanning');
    // a paused scan still counts as scanning for target changes
    expect(guard(view(rtaState({ scanState: 'paused' })), 'set_observation_frequency', 'main', 1.42e9)?.code).toBe('scanning');
    expect(guard(view(rtaState()), 'set_target', 'main', 'tgt-up')).toBeNull();
  });

  it('rejects an unknown catalogue target', () => {
    expect(guard(view(rtaState()), 'set_target', 'main', 'tgt-missing')?.code).toBe('unknown_target');
  });

  it('asks for confirmation before dropping below the 80-dish minimum', () => {
    const s = rtaState({ activeDishes: 80 });
    expect(guard(view(s), 'enable_dish', 'dish-001', false)).toBeNull();
    const c = confirm(view(s), 'enable_dish', 'dish-001', false);
    expect(c?.title).toMatch(/dish-001/);
    expect(c?.facts.join(' ')).toMatch(/79/);
  });

  it('refuses to disable or stow when the array is already at the minimum', () => {
    const s = rtaState({ activeDishes: 79 });
    expect(guard(view(s), 'enable_dish', 'dish-001', false)?.code).toBe('min_active_dishes');
    expect(guard(view(s), 'stow_dish', 'dish-001', true)?.code).toBe('min_active_dishes');
  });

  it('does not ask for confirmation when the array stays above the minimum', () => {
    expect(confirm(view(rtaState({ activeDishes: 90 })), 'stow_dish', 'dish-001', true)).toBeNull();
  });

  it('refuses slews for a stowed dish and releasing a dish during wind stow', () => {
    expect(guard(view(rtaState()), 'adjust_azimuth', 'dish-004', 1)?.code).toBe('stowed');
    expect(guard(view(rtaState({ windStow: true })), 'stow_dish', 'dish-001', false)?.code).toBe('wind_stow');
  });

  it('refuses a fifth sub-array', () => {
    const s = rtaState();
    for (const id of ['a', 'b', 'c']) {
      s.subarrays[id] = { ...s.subarrays['main']!, id, members: [] };
    }
    expect(guard(view(s), 'assign_subarray', 'dish-001', 'd')?.code).toBe('subarray_limit');
    expect(guard(view(s), 'assign_subarray', 'dish-001', 'b')).toBeNull();
  });

  it('refuses a scheduled scan in the past and cancelling an idle sub-array', () => {
    expect(guard(view(rtaState()), 'schedule_scan', 'main', T - 1000)?.code).toBe('invalid_value');
    expect(guard(view(rtaState()), 'schedule_scan', 'main', T + 60_000)).toBeNull();
    expect(guard(view(rtaState()), 'cancel_scan', 'main', true)?.code).toBe('not_scanning');
  });

  it('registers presets that only use controls the plugin exposes', () => {
    const names = new Set(rtaCommandSpecs(view(rtaState())).map((s) => s.control));
    for (const p of rtaPresets()) for (const step of p.steps) expect(names.has(step.control)).toBe(true);
  });
});

// ------------------------------------------------------------------ acks
function ack(commandId: string, body: Record<string, unknown>, simTs = T + 1000): ParsedAck {
  return {
    kind: 'ack',
    service: 'rta',
    topic: `arl/rta/ack/${commandId}`,
    recvTs: simTs,
    retained: false,
    entity: 'main',
    commandId,
    simTs,
    body,
  };
}

function inserted(db: ReturnType<typeof memDb>, commandId = 'cmd-1') {
  insertCommand(db, {
    commandId,
    service: 'rta',
    entity: 'main',
    control: 'set_target',
    value: 'tgt-cen',
    researcher: 'arl-as3',
    researcherName: 'A. Researcher',
    requestedTs: T,
    origin: 'operator',
  });
  return commandId;
}

describe('command acks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('walks pending → accepted → in_progress → completed and forces progress to 1', () => {
    const db = memDb();
    const id = inserted(db);
    const seen: string[] = [];
    const tracker = new AckTracker({ db, now: () => T, simNow: () => T, onChange: (c) => seen.push(c.state) });
    expect(commandDTO(getCommandRow(db, id)!).state).toBe('pending');
    tracker.track(id);

    expect(tracker.ingest(ack(id, { state: 'accepted', progress: 0 }))?.state).toBe('accepted');
    const mid = tracker.ingest(ack(id, { state: 'in_progress', progress: 0.4 }));
    expect(mid?.progress).toBeCloseTo(0.4);
    const done = tracker.ingest(ack(id, { state: 'completed', detail: 'scan-0007' }));
    expect(done?.state).toBe('completed');
    expect(done?.progress).toBe(1);
    expect(done?.detail).toBe('scan-0007');
    // a late duplicate after a terminal state is ignored
    expect(tracker.ingest(ack(id, { state: 'failed', reason: 'timeout' }))).toBeNull();
    expect(seen).toEqual(['accepted', 'in_progress', 'completed']);
    tracker.dispose();
  });

  it('keeps the rejection reason for the UI to explain', () => {
    const db = memDb();
    const id = inserted(db);
    const tracker = new AckTracker({ db, now: () => T, simNow: () => T, onChange: () => {} });
    const dto = tracker.ingest(ack(id, { state: 'rejected', reason: 'researcher_not_permitted' }));
    expect(dto?.reason).toBe('researcher_not_permitted');
    expect(explainCommandReason(dto?.reason, { service: 'rta' })).toBe('This researcher is not permitted to control RTA');
    tracker.dispose();
  });

  it('fails a command with reason=timeout when no ack arrives within 30 s', () => {
    vi.useFakeTimers();
    const db = memDb();
    const id = inserted(db);
    const tracker = new AckTracker({ db, now: () => T, simNow: () => T, onChange: () => {} });
    tracker.track(id);
    vi.advanceTimersByTime(29_000);
    expect(commandDTO(getCommandRow(db, id)!).state).toBe('pending');
    vi.advanceTimersByTime(1_500);
    const row = commandDTO(getCommandRow(db, id)!);
    expect(row.state).toBe('failed');
    expect(row.reason).toBe('timeout');
    tracker.dispose();
  });

  it('does not time out a command the service answered', () => {
    vi.useFakeTimers();
    const db = memDb();
    const id = inserted(db);
    const tracker = new AckTracker({ db, now: () => T, simNow: () => T, onChange: () => {} });
    tracker.track(id);
    tracker.ingest(ack(id, { state: 'completed' }));
    vi.advanceTimersByTime(60_000);
    expect(commandDTO(getCommandRow(db, id)!).state).toBe('completed');
    tracker.dispose();
  });
});

describe('reason text', () => {
  it('explains broker and platform reasons in plain language', () => {
    expect(explainCommandReason('controls_disabled')).toBe('Controls are disabled on the live broker');
    expect(explainCommandReason('timeout')).toMatch(/30 s/);
    expect(explainCommandReason('low_fuel')).toMatch(/2 %/);
    expect(explainCommandReason('something_new')).toBe('something new');
    expect(explainCommandReason(null)).toBeNull();
  });
});
