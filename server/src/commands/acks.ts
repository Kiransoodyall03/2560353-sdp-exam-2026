// Ack tracker: every published command is tracked until the service acknowledges it or 30 s pass
// without any ack (then state = failed, reason = timeout). Progress comes from the acks.
import { z } from 'zod';
import type { CommandDTO } from '../../../shared/types.js';
import type { ParsedAck } from '../core/parse.js';
import { commandDTO, getCommandRow, updateCommand, type CommandPatch } from '../db/commands.js';
import type { Db } from '../db/index.js';

export const ACK_TIMEOUT_MS = 30_000;
export const TERMINAL_STATES = new Set(['completed', 'failed', 'rejected']);

const AckBody = z
  .object({
    command_id: z.string().min(1).max(200).optional(),
    state: z.enum(['accepted', 'rejected', 'in_progress', 'completed', 'failed']),
    progress: z.number().finite().nullable().optional(),
    reason: z.string().max(400).nullable().optional(),
    detail: z.string().max(4000).nullable().optional(),
    control: z.string().optional(),
    target: z.string().optional(),
    researcher: z.string().optional(),
  })
  .passthrough();

export interface AckTrackerDeps {
  db: Db;
  now: () => number;
  /** Sim time for the row's updated_ts when the ack carries no ts. */
  simNow: () => number | null;
  onChange: (command: CommandDTO) => void;
  cancel?: (commandId: string) => void;
}

export class AckTracker {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: AckTrackerDeps) {}

  /** Starts the 30 s ack timeout for a freshly published command. */
  track(commandId: string): void {
    this.clear(commandId);
    const t = setTimeout(() => this.onTimeout(commandId), ACK_TIMEOUT_MS);
    t.unref?.();
    this.timers.set(commandId, t);
  }

  /** Applies a service ack. Returns the updated command, or null when the ack is not ours / is stale. */
  ingest(ack: ParsedAck): CommandDTO | null {
    const row = getCommandRow(this.deps.db, ack.commandId);
    if (!row) return null;
    if (TERMINAL_STATES.has(row.state)) return null; // late duplicate
    const parsed = AckBody.safeParse(ack.body);
    if (!parsed.success) return null;
    const a = parsed.data;
    const patch: CommandPatch = {
      state: a.state,
      updatedTs: ack.simTs ?? this.deps.simNow() ?? this.deps.now(),
    };
    if (a.progress !== undefined) patch.progress = a.progress === null ? null : Math.min(1, Math.max(0, a.progress));
    if (a.reason !== undefined) patch.reason = a.reason ?? null;
    if (a.detail !== undefined) patch.detail = a.detail ?? null;
    if (a.state === 'completed') patch.progress = 1;
    updateCommand(this.deps.db, row.command_id, patch);
    if (TERMINAL_STATES.has(a.state)) this.clear(row.command_id);
    const next = getCommandRow(this.deps.db, row.command_id);
    const dto = next ? commandDTO(next) : null;
    if (dto) this.deps.onChange(dto);
    return dto;
  }

  /** Clears every timer (shutdown). */
  dispose(): void {
    for (const id of [...this.timers.keys()]) this.clear(id);
  }

  private onTimeout(commandId: string): void {
    this.timers.delete(commandId);
    const row = getCommandRow(this.deps.db, commandId);
    if (!row || TERMINAL_STATES.has(row.state)) return;
    updateCommand(this.deps.db, commandId, {
      state: 'failed',
      reason: 'timeout',
      detail: `No acknowledgement from the service within ${ACK_TIMEOUT_MS / 1000} s`,
      updatedTs: this.deps.simNow() ?? this.deps.now(),
    });
    const next = getCommandRow(this.deps.db, commandId);
    if (next) this.deps.onChange(commandDTO(next));
  }

  private clear(commandId: string): void {
    const t = this.timers.get(commandId);
    if (t) clearTimeout(t);
    this.timers.delete(commandId);
  }
}
