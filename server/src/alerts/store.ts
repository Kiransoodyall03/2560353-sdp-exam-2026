// Alert persistence: one row per (service, alert_id) + an append-only audit trail (alert_events).
// Open alerts (not resolved) are mirrored in memory for the annunciator.
import type { AlertDTO, AlertEventDTO, AlertService, AlertSummaryDTO, Severity } from '../../../shared/types.js';
import type { Db } from '../db/index.js';

export const alertKey = (service: string, alertId: string) => `${service}:${alertId}`;

interface AlertRow {
  service: string;
  alert_id: string;
  type: string;
  severity: string;
  max_severity: string;
  entity: string | null;
  svc_state: string;
  op_state: string;
  raised_ts: number | null;
  cleared_ts: number | null;
  value: number | null;
  limit: number | null;
  unit: string | null;
  message: string;
  metadata_json: string;
  placeholder: number;
  ack_ts: number | null;
  ack_by: string | null;
  ack_name: string | null;
  ack_note: string | null;
  resolved_ts: number | null;
  resolved_by: string | null;
  resolved_name: string | null;
  resolution_note: string | null;
  updated_wall_ts: number;
}

function fromRow(r: AlertRow): AlertDTO {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
  } catch {
    /* keep empty */
  }
  return {
    key: alertKey(r.service, r.alert_id),
    service: r.service as AlertService,
    alertId: r.alert_id,
    type: r.type,
    severity: r.severity as Severity,
    maxSeverity: r.max_severity as Severity,
    entity: r.entity,
    svcState: r.svc_state as AlertDTO['svcState'],
    opState: r.op_state as AlertDTO['opState'],
    raisedTs: r.raised_ts,
    clearedTs: r.cleared_ts,
    value: r.value,
    limit: r.limit,
    unit: r.unit,
    message: r.message,
    metadata,
    placeholder: r.placeholder === 1,
    ackTs: r.ack_ts,
    ackBy: r.ack_by,
    ackName: r.ack_name,
    ackNote: r.ack_note,
    resolvedTs: r.resolved_ts,
    resolvedBy: r.resolved_by,
    resolvedName: r.resolved_name,
    resolutionNote: r.resolution_note,
    updatedWallTs: r.updated_wall_ts,
  };
}

export interface AlertFilter {
  service?: string;
  severity?: Severity;
  opState?: AlertDTO['opState'];
  svcState?: AlertDTO['svcState'];
  includeResolved?: boolean;
  limit?: number;
}

export class AlertStore {
  private readonly open = new Map<string, AlertDTO>();
  private readonly upsertStmt;
  private readonly eventStmt;

  constructor(
    private readonly db: Db,
    private readonly wallNow: () => number = Date.now,
  ) {
    this.upsertStmt = db.prepare(`
      INSERT INTO alerts (service, alert_id, type, severity, max_severity, entity, svc_state, op_state, raised_ts,
        cleared_ts, value, "limit", unit, message, metadata_json, placeholder, ack_ts, ack_by, ack_name, ack_note,
        resolved_ts, resolved_by, resolved_name, resolution_note, updated_wall_ts)
      VALUES (@service, @alertId, @type, @severity, @maxSeverity, @entity, @svcState, @opState, @raisedTs,
        @clearedTs, @value, @limit, @unit, @message, @metadataJson, @placeholderInt, @ackTs, @ackBy, @ackName, @ackNote,
        @resolvedTs, @resolvedBy, @resolvedName, @resolutionNote, @updatedWallTs)
      ON CONFLICT (service, alert_id) DO UPDATE SET
        type = excluded.type, severity = excluded.severity, max_severity = excluded.max_severity,
        entity = excluded.entity, svc_state = excluded.svc_state, op_state = excluded.op_state,
        raised_ts = excluded.raised_ts, cleared_ts = excluded.cleared_ts, value = excluded.value,
        "limit" = excluded."limit", unit = excluded.unit, message = excluded.message,
        metadata_json = excluded.metadata_json, placeholder = excluded.placeholder, ack_ts = excluded.ack_ts,
        ack_by = excluded.ack_by, ack_name = excluded.ack_name, ack_note = excluded.ack_note,
        resolved_ts = excluded.resolved_ts, resolved_by = excluded.resolved_by,
        resolved_name = excluded.resolved_name, resolution_note = excluded.resolution_note,
        updated_wall_ts = excluded.updated_wall_ts`);
    this.eventStmt = db.prepare(
      `INSERT INTO alert_events (service, alert_id, sim_ts, wall_ts, action, actor, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const rows = db.prepare(`SELECT * FROM alerts WHERE op_state != 'resolved'`).all() as AlertRow[];
    for (const r of rows) {
      const a = fromRow(r);
      this.open.set(a.key, a);
    }
  }

  get(service: string, alertId: string): AlertDTO | null {
    const key = alertKey(service, alertId);
    const hit = this.open.get(key);
    if (hit) return hit;
    const row = this.db.prepare(`SELECT * FROM alerts WHERE service = ? AND alert_id = ?`).get(service, alertId) as
      | AlertRow
      | undefined;
    return row ? fromRow(row) : null;
  }

  save(a: AlertDTO): AlertDTO {
    a.updatedWallTs = this.wallNow();
    this.upsertStmt.run({
      ...a,
      metadataJson: JSON.stringify(a.metadata ?? {}),
      placeholderInt: a.placeholder ? 1 : 0,
    });
    if (a.opState === 'resolved') this.open.delete(a.key);
    else this.open.set(a.key, a);
    return a;
  }

  addEvent(
    service: string,
    alertId: string,
    simTs: number | null,
    action: string,
    actor: string | null,
    detail: Record<string, unknown> = {},
  ): void {
    this.eventStmt.run(service, alertId, simTs, this.wallNow(), action, actor, JSON.stringify(detail));
  }

  events(service: string, alertId: string): AlertEventDTO[] {
    const rows = this.db
      .prepare(`SELECT * FROM alert_events WHERE service = ? AND alert_id = ? ORDER BY id`)
      .all(service, alertId) as {
      id: number;
      service: string;
      alert_id: string;
      sim_ts: number | null;
      wall_ts: number;
      action: string;
      actor: string | null;
      detail_json: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      service: r.service as AlertService,
      alertId: r.alert_id,
      simTs: r.sim_ts,
      wallTs: r.wall_ts,
      action: r.action,
      actor: r.actor,
      detail: safeJson(r.detail_json),
    }));
  }

  openAlerts(): AlertDTO[] {
    return [...this.open.values()];
  }

  openForService(service: string): AlertDTO[] {
    return this.openAlerts().filter((a) => a.service === service);
  }

  list(f: AlertFilter = {}): AlertDTO[] {
    const limit = Math.min(Math.max(f.limit ?? 5000, 1), 20000);
    let items: AlertDTO[];
    if (f.includeResolved || f.opState === 'resolved') {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.service) {
        where.push('service = ?');
        args.push(f.service);
      }
      if (f.opState) {
        where.push('op_state = ?');
        args.push(f.opState);
      }
      const sql = `SELECT * FROM alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY updated_wall_ts DESC LIMIT ?`;
      items = (this.db.prepare(sql).all(...args, limit) as AlertRow[]).map(fromRow);
    } else {
      items = this.openAlerts();
    }
    return items
      .filter(
        (a) =>
          (!f.service || a.service === f.service) &&
          (!f.severity || a.severity === f.severity) &&
          (!f.opState || a.opState === f.opState) &&
          (!f.svcState || a.svcState === f.svcState),
      )
      .slice(0, limit);
  }

  summary(): AlertSummaryDTO {
    const s: AlertSummaryDTO = { unacked: { info: 0, warning: 0, critical: 0 }, open: 0, raised: 0, byService: {} };
    for (const a of this.open.values()) {
      s.open++;
      if (a.svcState === 'raised') s.raised++;
      const b = (s.byService[a.service] ??= { unacked: 0, open: 0 });
      b.open++;
      if (a.opState === 'unacked') {
        s.unacked[a.severity]++;
        b.unacked++;
      }
    }
    return s;
  }

  /** Highest occurrence counter used for platform alert ids with this base. */
  maxCounter(service: string, base: string): number {
    const rows = this.db
      .prepare(`SELECT alert_id FROM alerts WHERE service = ? AND alert_id LIKE ? ESCAPE '\\'`)
      .all(service, `${base.replace(/[\\%_]/g, (c) => '\\' + c)}-%`) as { alert_id: string }[];
    let max = 0;
    for (const r of rows) {
      const m = /-(\d+)$/.exec(r.alert_id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
