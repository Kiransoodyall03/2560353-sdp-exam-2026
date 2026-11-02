// Schedules: a server timer runs a preset (or a set of steps) at a simulated time, re-verifying the
// researcher and re-checking every safeguard when it fires.
import type { ServiceId } from '../../../shared/types.js';
import { SERVICES } from '../../../shared/types.js';
import { dueSchedules, setScheduleState, type ScheduleRow } from '../db/commands.js';
import type { SimClock } from '../core/clock.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../log.js';
import { maskCode } from '../log.js';
import type { CommandService } from './service.js';
import type { PresetStep } from './types.js';

export interface ScheduleDeps {
  db: Db;
  clock: SimClock;
  log: Logger;
  commands: CommandService;
  /** POST /v1/researchers/verify for the schedule's service; null when the code is not valid. */
  verify(code: string, service: ServiceId): Promise<{ code: string; name: string } | null>;
  tickMs?: number;
}

export class ScheduleRunner {
  private timer: NodeJS.Timeout | null = null;
  private readonly busy = new Set<number>();

  constructor(private readonly deps: ScheduleDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    for (const service of SERVICES) {
      const now = this.deps.clock.now(service);
      if (now === null) continue;
      let due: ScheduleRow[];
      try {
        due = dueSchedules(this.deps.db, service, now);
      } catch (err) {
        this.deps.log.warn({ err }, 'schedule lookup failed');
        continue;
      }
      for (const s of due) {
        if (this.busy.has(s.id)) continue;
        this.busy.add(s.id);
        try {
          await this.run(s, service);
        } finally {
          this.busy.delete(s.id);
        }
      }
    }
  }

  private async run(row: ScheduleRow, service: ServiceId): Promise<void> {
    setScheduleState(this.deps.db, row.id, 'running');
    let steps: PresetStep[] = [];
    try {
      steps = row.steps_json ? (JSON.parse(row.steps_json) as PresetStep[]) : [];
    } catch {
      steps = [];
    }
    if (steps.length === 0) {
      setScheduleState(this.deps.db, row.id, 'failed', 'The schedule has no steps');
      return;
    }
    const researcher = await this.deps.verify(row.researcher, service);
    if (!researcher) {
      this.deps.log.warn({ schedule: row.id, service, by: maskCode(row.researcher) }, 'scheduled run skipped: researcher invalid');
      setScheduleState(this.deps.db, row.id, 'failed', 'The researcher code is no longer valid for this service');
      return;
    }
    const { results, failed } = await this.deps.commands.runSteps(service, steps, researcher, 'schedule');
    const detail =
      failed.length === 0
        ? `${results.length} step(s) published`
        : `${failed.length} of ${results.length} step(s) refused: ${failed.map((f) => `${f.control} (${f.error})`).join(', ')}`;
    setScheduleState(this.deps.db, row.id, failed.length ? 'failed' : 'completed', detail);
    this.deps.log.info({ schedule: row.id, service, failed: failed.length }, 'scheduled run finished');
  }
}
