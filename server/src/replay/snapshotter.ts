// Snapshotter: writes each registered plugin's reducer state to state_snapshots every SNAPSHOT_EVERY_MS of
// sim time, so a replay seek can restore the nearest checkpoint and fold only the rows after it instead of
// replaying the whole history. Hooked once into the live ingest path (writer.onFlush), after a batch has
// committed and been dispatched. Iterating the live plugin registry means plugins registered later (LWM)
// are included with no change here.
//
// What is stored: {plugin, generic}. `plugin` is the plugin's public reducer `state` (RtaState / OpgState),
// NOT snapshot() — snapshot() returns a presentation DTO (e.g. RTA {dishes, subarrays, global, scans}) that
// cannot be folded back into reducer state, and OPG has no restore() at all. `generic` is the StateStore's
// per-service retained state + latest telemetry: the whole of a generic plugin's (LWM) replayable state and
// part of every /api/services/:svc/state DTO. seek() restores both, then replays raw_messages forward.
import type Database from 'better-sqlite3';
import type { Parsed } from '../core/parse.js';
import type { StateStore } from '../core/state-store.js';
import type { Db } from '../db/index.js';
import type { Plugin } from '../plugins/types.js';
import { SNAPSHOT_EVERY_MS } from './types.js';

export class Snapshotter {
  private readonly insert: Database.Statement;
  private readonly last = new Map<string, number>(); // service → sim_ts of its last stored snapshot

  constructor(
    private readonly db: Db,
    private readonly plugins: Map<string, Plugin>,
    private readonly store: StateStore,
  ) {
    this.insert = db.prepare(`INSERT OR REPLACE INTO state_snapshots (service, sim_ts, json) VALUES (?, ?, ?)`);
  }

  /** Called once after a batch commits: snapshot any service whose sim time advanced ≥ 60 s since the last. */
  onFlush(batch: Parsed[]): void {
    if (batch.length === 0) return;
    const maxByService = new Map<string, number>();
    for (const p of batch) {
      if (typeof p.simTs !== 'number') continue; // topology/cmd/invalid carry no sim ts of their own
      const prev = maxByService.get(p.service);
      if (prev === undefined || p.simTs > prev) maxByService.set(p.service, p.simTs);
    }
    for (const [service, ts] of maxByService) {
      const last = this.last.get(service);
      // First batch for a service snapshots immediately; afterwards at most one per 60 s of sim time.
      // NB: if a single flush only drains part of a >5000-row queue, the state can run ahead of this label;
      // that edge needs a degraded backlog and is bounded by one flush, so it is left as-is.
      if (last !== undefined && ts - last < SNAPSHOT_EVERY_MS) continue;
      const plugin = this.plugins.get(service);
      const payload = { plugin: plugin ? this.stateOf(plugin) : null, generic: this.store.snapshot(service) };
      this.insert.run(service, ts, JSON.stringify(payload));
      this.last.set(service, ts);
    }
  }

  /** The plugin's restorable reducer `state`; falls back to snapshot(); null when it has neither. */
  private stateOf(plugin: Plugin): unknown | null {
    try {
      const state = (plugin as unknown as { state?: unknown }).state;
      if (state && typeof state === 'object') return state;
      if (typeof plugin.snapshot === 'function') return plugin.snapshot() ?? null;
    } catch {
      /* a plugin that cannot be serialised is simply skipped */
    }
    return null;
  }
}
