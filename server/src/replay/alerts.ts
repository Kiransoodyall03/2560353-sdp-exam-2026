// Rebuild the annunciator as it was at a sim instant. alert_events is append-only and every workflow
// transition (raised / escalated / cleared / acked / resolved …) is recorded there with its sim ts and
// actor, so folding the events up to t reproduces exactly what an operator saw at that moment. The static
// label fields (type, entity, unit, message, metadata) are taken from the alerts row: `updated` events are
// not stored, so the latest label is the best available and only cosmetic fields can differ.
import {
  SEVERITY_RANK,
  type AlertDTO,
  type AlertService,
  type AlertSummaryDTO,
  type Severity,
} from '../../../shared/types.js';
import { alertKey } from '../alerts/store.js';
import { decodeAlertId, DEFAULT_SEVERITY } from '../alerts/workflow.js';
import type { Db } from '../db/index.js';

interface StaticRow {
  service: string;
  alert_id: string;
  type: string;
  severity: string;
  max_severity: string;
  entity: string | null;
  value: number | null;
  limit: number | null;
  unit: string | null;
  message: string;
  metadata_json: string;
}

interface EventRow {
  service: string;
  alert_id: string;
  sim_ts: number;
  wall_ts: number;
  action: string;
  actor: string | null;
  detail_json: string;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const maxSev = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sevOr = (v: unknown, fallback: Severity): Severity =>
  v === 'info' || v === 'warning' || v === 'critical' ? v : fallback;

/** A blank alert (mirrors AlertWorkflow.blank) seeded with the static label fields from the alerts row. */
function seedAlert(service: string, alertId: string, row: StaticRow | undefined): AlertDTO {
  const decoded = decodeAlertId(service, alertId);
  const type = row?.type ?? decoded.type;
  const severity = sevOr(row?.severity, DEFAULT_SEVERITY[type] ?? 'warning');
  let metadata: Record<string, unknown> = {};
  if (row) metadata = safeJson(row.metadata_json);
  return {
    key: alertKey(service, alertId),
    service: service as AlertService,
    alertId,
    type,
    severity,
    maxSeverity: sevOr(row?.max_severity, severity),
    entity: row?.entity ?? decoded.entity,
    svcState: 'raised',
    opState: 'unacked',
    raisedTs: null,
    clearedTs: null,
    value: row?.value ?? null,
    limit: row?.limit ?? null,
    unit: row?.unit ?? null,
    message: row?.message ?? '',
    metadata,
    placeholder: false,
    ackTs: null,
    ackBy: null,
    ackName: null,
    ackNote: null,
    resolvedTs: null,
    resolvedBy: null,
    resolvedName: null,
    resolutionNote: null,
    updatedWallTs: 0,
  };
}

/** Applies one audit event to the alert being rebuilt (the inverse of AlertWorkflow's transitions). */
function applyEvent(a: AlertDTO, ev: EventRow): void {
  const d = safeJson(ev.detail_json);
  const ts = ev.sim_ts;
  a.updatedWallTs = ev.wall_ts;
  switch (ev.action) {
    case 'raised':
      a.svcState = 'raised';
      a.opState = 'unacked';
      a.placeholder = false;
      a.clearedTs = null;
      a.raisedTs = ts;
      a.severity = sevOr(d['severity'], a.severity);
      a.maxSeverity = maxSev(a.maxSeverity, a.severity);
      if ('value' in d) a.value = numOrNull(d['value']);
      if ('limit' in d) a.limit = numOrNull(d['limit']);
      break;
    case 'escalated':
      a.svcState = 'raised';
      a.severity = sevOr(d['to'], a.severity);
      a.maxSeverity = maxSev(a.maxSeverity, a.severity);
      if ('value' in d) a.value = numOrNull(d['value']);
      break;
    case 'deescalated':
      a.svcState = 'raised';
      a.severity = sevOr(d['to'], a.severity);
      if ('value' in d) a.value = numOrNull(d['value']);
      break;
    case 'reraised':
      a.svcState = 'raised';
      a.placeholder = false;
      a.raisedTs = ts;
      a.clearedTs = null;
      a.severity = sevOr(d['to'], sevOr(d['severity'], a.severity));
      a.maxSeverity = maxSev(a.maxSeverity, a.severity);
      if ('value' in d) a.value = numOrNull(d['value']);
      break;
    case 'captured':
      a.svcState = 'raised';
      a.placeholder = false;
      delete a.metadata['raised_before_capture'];
      a.severity = sevOr(d['to'], a.severity);
      a.maxSeverity = maxSev(a.maxSeverity, a.severity);
      if ('value' in d) a.value = numOrNull(d['value']);
      break;
    case 'reopened':
      a.opState = 'unacked';
      a.resolvedTs = null;
      a.resolvedBy = null;
      a.resolvedName = null;
      a.resolutionNote = null;
      break;
    case 'cleared':
      a.svcState = 'cleared';
      a.clearedTs = ts;
      if (numOrNull(d['value']) !== null) a.value = numOrNull(d['value']);
      if (d['raised_before_capture'] === true) {
        a.placeholder = true;
        a.metadata = { ...a.metadata, raised_before_capture: true };
      }
      break;
    case 'cleared_by_reconcile':
      a.svcState = 'cleared';
      a.clearedTs = ts;
      break;
    case 'reconciled':
      a.svcState = 'raised';
      a.clearedTs = null;
      break;
    case 'reconciled_placeholder':
      a.svcState = 'raised';
      a.opState = 'unacked';
      a.placeholder = true;
      a.message = a.message || 'Raised before capture — details unknown until the service re-publishes it';
      a.metadata = { ...a.metadata, raised_before_capture: true, severity_unknown: true };
      break;
    case 'details_from_backlog':
      a.placeholder = false;
      a.severity = sevOr(d['severity'], a.severity);
      a.maxSeverity = a.severity;
      if (numOrNull(d['raised_ts']) !== null) a.raisedTs = numOrNull(d['raised_ts']);
      a.metadata = { ...a.metadata, raised_before_capture: true, details_source: 'api_backlog' };
      break;
    case 'acked':
      a.opState = 'acked';
      a.ackTs = ts;
      a.ackBy = ev.actor;
      a.ackName = typeof d['name'] === 'string' ? d['name'] : null;
      a.ackNote = typeof d['note'] === 'string' ? d['note'] : null;
      break;
    case 'resolved':
      a.opState = 'resolved';
      a.resolvedTs = ts;
      a.resolvedBy = ev.actor;
      a.resolvedName = typeof d['name'] === 'string' ? d['name'] : null;
      a.resolutionNote = typeof d['note'] === 'string' ? d['note'] : null;
      break;
    default:
      break; // 'updated' and any future action: no state we track changes
  }
}

/** Every alert as it stood at sim time t, in first-event order (includes ones resolved by t). */
export function alertStateAtT(db: Db, t: number): AlertDTO[] {
  const staticRows = db
    .prepare(
      `SELECT service, alert_id, type, severity, max_severity, entity, value, "limit", unit, message, metadata_json
       FROM alerts`,
    )
    .all() as StaticRow[];
  const staticByKey = new Map<string, StaticRow>();
  for (const r of staticRows) staticByKey.set(alertKey(r.service, r.alert_id), r);

  const events = db
    .prepare(
      `SELECT service, alert_id, sim_ts, wall_ts, action, actor, detail_json
       FROM alert_events WHERE sim_ts IS NOT NULL AND sim_ts <= ? ORDER BY id`,
    )
    .all(t) as EventRow[];

  const out = new Map<string, AlertDTO>();
  for (const ev of events) {
    const key = alertKey(ev.service, ev.alert_id);
    let a = out.get(key);
    if (!a) {
      a = seedAlert(ev.service, ev.alert_id, staticByKey.get(key));
      out.set(key, a);
    }
    applyEvent(a, ev);
  }
  return [...out.values()];
}

/** Same counts as AlertStore.summary(), over the alerts open (not resolved) at t. */
export function summarize(alerts: AlertDTO[]): AlertSummaryDTO {
  const s: AlertSummaryDTO = { unacked: { info: 0, warning: 0, critical: 0 }, open: 0, raised: 0, byService: {} };
  for (const a of alerts) {
    if (a.opState === 'resolved') continue; // the live `open` mirror excludes resolved alerts
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

/**
 * Read-only stand-in for AlertStore during a replay: the plugin views (e.g. RTA dish alert badges) call
 * openForService()/summary() and must see the alerts as they were at t, never the live set. Cast to
 * AlertStore when building the isolated plugin context.
 */
export class ReplayAlertStore {
  private alerts: AlertDTO[] = [];

  set(alerts: AlertDTO[]): void {
    this.alerts = alerts;
  }

  openAlerts(): AlertDTO[] {
    return this.alerts.filter((a) => a.opState !== 'resolved');
  }

  openForService(service: string): AlertDTO[] {
    return this.openAlerts().filter((a) => a.service === service);
  }

  get(service: string, alertId: string): AlertDTO | null {
    return this.alerts.find((a) => a.service === service && a.alertId === alertId) ?? null;
  }

  summary(): AlertSummaryDTO {
    return summarize(this.alerts);
  }
}
