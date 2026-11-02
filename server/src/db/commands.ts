// commands / presets / schedules persistence. Parameterised SQL only; the researcher code is stored
// for audit but masked on the way out to the UI (rule 2).
import type { PresetDTO, PresetStepDTO, ScheduleDTO } from '../../../shared/commands.js';
import type { CommandDTO, ServiceId } from '../../../shared/types.js';
import { isServiceId } from '../../../shared/types.js';
import { maskCode } from '../log.js';
import type { Db } from './index.js';

export interface CommandRow {
  command_id: string;
  service: string;
  entity: string;
  control: string;
  value_json: string;
  researcher: string;
  researcher_name: string | null;
  requested_ts: number;
  state: string;
  progress: number | null;
  reason: string | null;
  detail: string | null;
  updated_ts: number;
  origin: string;
}

export function parseValue(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function commandDTO(r: CommandRow): CommandDTO {
  return {
    commandId: r.command_id,
    service: (isServiceId(r.service) ? r.service : 'rta') as ServiceId,
    entity: r.entity,
    control: r.control,
    value: parseValue(r.value_json),
    researcher: maskCode(r.researcher),
    requestedTs: r.requested_ts,
    state: r.state,
    progress: r.progress,
    reason: r.reason,
    detail: r.detail,
    updatedTs: r.updated_ts,
  };
}

export interface NewCommand {
  commandId: string;
  service: string;
  entity: string;
  control: string;
  value: unknown;
  researcher: string;
  researcherName: string | null;
  requestedTs: number;
  origin: string;
}

export function insertCommand(db: Db, c: NewCommand): void {
  db.prepare(
    `INSERT INTO commands (command_id, service, entity, control, value_json, researcher, researcher_name,
       requested_ts, state, progress, reason, detail, updated_ts, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
  ).run(
    c.commandId,
    c.service,
    c.entity,
    c.control,
    JSON.stringify(c.value ?? null),
    c.researcher,
    c.researcherName,
    c.requestedTs,
    c.requestedTs,
    c.origin,
  );
}

export interface CommandPatch {
  state?: string;
  progress?: number | null;
  reason?: string | null;
  detail?: string | null;
  updatedTs: number;
}

const PATCH_COLUMNS: Record<keyof Omit<CommandPatch, 'updatedTs'>, string> = {
  state: 'state',
  progress: 'progress',
  reason: 'reason',
  detail: 'detail',
};

export function updateCommand(db: Db, commandId: string, patch: CommandPatch): void {
  const sets: string[] = ['updated_ts = ?'];
  const args: unknown[] = [patch.updatedTs];
  for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
    const v = patch[key as keyof typeof PATCH_COLUMNS];
    if (v === undefined) continue;
    sets.push(`${column} = ?`);
    args.push(v);
  }
  args.push(commandId);
  db.prepare(`UPDATE commands SET ${sets.join(', ')} WHERE command_id = ?`).run(...args);
}

export function getCommandRow(db: Db, commandId: string): CommandRow | null {
  return (db.prepare('SELECT * FROM commands WHERE command_id = ?').get(commandId) as CommandRow | undefined) ?? null;
}

export interface ListCommandsQuery {
  service?: string;
  entity?: string;
  limit?: number;
}

export function listCommandRows(db: Db, q: ListCommandsQuery = {}): CommandRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.service) {
    where.push('service = ?');
    args.push(q.service);
  }
  if (q.entity) {
    where.push('entity = ?');
    args.push(q.entity);
  }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const sql = `SELECT * FROM commands ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY requested_ts DESC, rowid DESC LIMIT ${limit}`;
  return db.prepare(sql).all(...args) as CommandRow[];
}

/** Commands issued in a sim-time window (used on the alert detail page). */
export function commandsBetween(db: Db, service: string, from: number, to: number, limit = 50): CommandRow[] {
  return db
    .prepare(`SELECT * FROM commands WHERE service = ? AND requested_ts BETWEEN ? AND ? ORDER BY requested_ts DESC LIMIT ?`)
    .all(service, from, to, limit) as CommandRow[];
}

// ------------------------------------------------------------------ presets
interface PresetRow {
  id: string;
  service: string;
  name: string;
  steps_json: string;
}

export function upsertPresets(db: Db, service: string, presets: { id: string; name: string; steps: PresetStepDTO[] }[]): void {
  const stmt = db.prepare(
    `INSERT INTO presets (id, service, name, steps_json) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET service = excluded.service, name = excluded.name, steps_json = excluded.steps_json`,
  );
  for (const p of presets) stmt.run(p.id, service, p.name, JSON.stringify(p.steps));
}

export function presetRows(db: Db, service?: string): PresetRow[] {
  return (service
    ? db.prepare('SELECT * FROM presets WHERE service = ? ORDER BY name').all(service)
    : db.prepare('SELECT * FROM presets ORDER BY service, name').all()) as PresetRow[];
}

export function presetDTOs(db: Db, service?: string, description?: (id: string) => string): PresetDTO[] {
  return presetRows(db, service).flatMap((r) => {
    if (!isServiceId(r.service)) return [];
    let steps: PresetStepDTO[] = [];
    try {
      steps = JSON.parse(r.steps_json) as PresetStepDTO[];
    } catch {
      steps = [];
    }
    return [{ id: r.id, service: r.service, name: r.name, description: description?.(r.id) ?? '', steps }];
  });
}

// ---------------------------------------------------------------- schedules
export interface ScheduleRow {
  id: number;
  service: string;
  name: string;
  preset_id: string | null;
  steps_json: string | null;
  at_sim_ts: number;
  researcher: string;
  state: string;
  detail: string | null;
  created_wall_ts: number;
}

export function scheduleDTO(r: ScheduleRow): ScheduleDTO {
  let steps: PresetStepDTO[] = [];
  try {
    steps = r.steps_json ? (JSON.parse(r.steps_json) as PresetStepDTO[]) : [];
  } catch {
    steps = [];
  }
  return {
    id: r.id,
    service: (isServiceId(r.service) ? r.service : 'rta') as ServiceId,
    name: r.name,
    presetId: r.preset_id,
    steps,
    atSimTs: r.at_sim_ts,
    researcher: maskCode(r.researcher),
    state: (['pending', 'running', 'completed', 'failed', 'cancelled'].includes(r.state) ? r.state : 'pending') as ScheduleDTO['state'],
    detail: r.detail,
    createdWallTs: r.created_wall_ts,
  };
}

export function insertSchedule(
  db: Db,
  s: {
    service: string;
    name: string;
    presetId: string | null;
    steps: PresetStepDTO[];
    atSimTs: number;
    researcher: string;
    wallTs: number;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO schedules (service, name, preset_id, steps_json, at_sim_ts, researcher, state, detail, created_wall_ts)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
    )
    .run(s.service, s.name, s.presetId, JSON.stringify(s.steps), s.atSimTs, s.researcher, s.wallTs);
  return Number(info.lastInsertRowid);
}

export function dueSchedules(db: Db, service: string, simNow: number): ScheduleRow[] {
  return db
    .prepare(`SELECT * FROM schedules WHERE service = ? AND state = 'pending' AND at_sim_ts <= ? ORDER BY at_sim_ts`)
    .all(service, simNow) as ScheduleRow[];
}

export function setScheduleState(db: Db, id: number, state: string, detail: string | null = null): void {
  db.prepare('UPDATE schedules SET state = ?, detail = ? WHERE id = ?').run(state, detail, id);
}

export function getScheduleRow(db: Db, id: number): ScheduleRow | null {
  return (db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined) ?? null;
}

export function listSchedules(db: Db, service?: string, limit = 50): ScheduleDTO[] {
  const rows = (service
    ? db.prepare('SELECT * FROM schedules WHERE service = ? ORDER BY at_sim_ts DESC LIMIT ?').all(service, limit)
    : db.prepare('SELECT * FROM schedules ORDER BY at_sim_ts DESC LIMIT ?').all(limit)) as ScheduleRow[];
  return rows.map(scheduleDTO);
}
