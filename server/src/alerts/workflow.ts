// Operator workflow on top of the alerts the services publish (they own the thresholds; we never re-implement
// them). Key = (service, alert_id). Raised → create/update (escalation keeps the id). Cleared → svc_state
// cleared but the alert stays on the annunciator until resolved. Ack (verified researcher, optional note) →
// Resolve (verified researcher, required note). Every transition is appended to alert_events.
import { z } from 'zod';
import { SEVERITY_RANK, type AlertDTO, type AlertService, type Severity } from '../../../shared/types.js';
import type { VerifiedResearcher } from '../researchers/verify.js';
import { alertKey, type AlertStore } from './store.js';

export const AlertPayload = z
  .object({
    alert_id: z.string().min(1).max(200),
    type: z.string().min(1).max(100),
    severity: z.enum(['info', 'warning', 'critical']),
    state: z.enum(['raised', 'cleared']),
    entity: z.string().max(100).nullable().optional(),
    value: z.number().nullable().optional(),
    limit: z.number().nullable().optional(),
    unit: z.string().max(40).nullable().optional(),
    message: z.string().max(2000).nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
    ts: z.number(),
  })
  .passthrough();
export type AlertPayload = z.infer<typeof AlertPayload>;

/** Pure: validate an arl/<svc>/events/alert body. */
export function parseAlertPayload(body: unknown): AlertPayload | null {
  const r = AlertPayload.safeParse(body);
  return r.success ? r.data : null;
}

/** Best-effort decode of `<svc>-<type>-<entity>-<nnnn>` for placeholders (types use _, entities use -). */
export function decodeAlertId(service: string, alertId: string): { type: string; entity: string | null } {
  let rest = alertId.startsWith(`${service}-`) ? alertId.slice(service.length + 1) : alertId;
  rest = rest.replace(/-\d+$/, '');
  const i = rest.indexOf('-');
  if (i < 0) return { type: rest || 'unknown', entity: null };
  return { type: rest.slice(0, i), entity: rest.slice(i + 1) || null };
}

export interface AlertChange {
  alert: AlertDTO;
  action: string;
}
export type WorkflowResult =
  | { ok: true; alert: AlertDTO }
  | { ok: false; code: 'not_found' | 'already_resolved' | 'already_acked' | 'not_acked' | 'note_required'; message: string };

export const NOTE_MAX = 2000;
const maxSev = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

/** Initial severity per alert type from the service specs (Alerts tables); placeholders use it until details arrive. */
export const DEFAULT_SEVERITY: Record<string, Severity> = {
  availability: 'critical',
  wind_stow: 'warning',
  dish_offline: 'warning',
  dish_temperature: 'warning',
  dish_power: 'warning',
  dish_movement: 'warning',
  dish_calibration: 'info',
  dish_scan: 'warning',
  site_offline: 'warning',
  high_wind: 'warning',
  lightning_proximity: 'warning',
  storm_approach: 'warning',
  extreme_temperature: 'warning',
  heavy_rain: 'warning',
  low_battery: 'warning',
  sensor_fault: 'warning',
  calibration_overdue: 'info',
  soiling: 'warning',
  pan_level: 'info',
  supply_shortfall: 'critical',
  backup_active: 'info',
  solar_underperformance: 'warning',
  battery_temperature: 'warning',
  low_fuel: 'warning',
  generator_fault: 'critical',
};

export interface PlatformAlertSpec {
  subject: string; // e.g. rta, broker, api, ingestion
  type: string; // service_offline, stream_silent, seq_gap, broker_disconnected, api_unreachable, ingestion_degraded
  severity: Severity;
  message: string;
  entity?: string | null;
  value?: number | null;
  limit?: number | null;
  unit?: string | null;
  metadata?: Record<string, unknown>;
}

type Listener = (change: AlertChange) => void;

export class AlertWorkflow {
  private readonly listeners: Listener[] = [];
  private readonly counters = new Map<string, number>();

  constructor(private readonly store: AlertStore) {}

  onChange(l: Listener): void {
    this.listeners.push(l);
  }

  private emit(alert: AlertDTO, action: string): AlertChange {
    const change = { alert, action };
    for (const l of this.listeners) l(change);
    return change;
  }

  private blank(service: AlertService, alertId: string, type: string, severity: Severity): AlertDTO {
    return {
      key: alertKey(service, alertId),
      service,
      alertId,
      type,
      severity,
      maxSeverity: severity,
      entity: null,
      svcState: 'raised',
      opState: 'unacked',
      raisedTs: null,
      clearedTs: null,
      value: null,
      limit: null,
      unit: null,
      message: '',
      metadata: {},
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

  /** Reopen an alert for the operator (escalation or a new occurrence after clear/resolve). */
  private reopen(a: AlertDTO, simTs: number, why: string): void {
    if (a.opState === 'unacked') return;
    const prev = a.opState;
    a.opState = 'unacked';
    a.resolvedTs = null;
    a.resolvedBy = null;
    a.resolvedName = null;
    a.resolutionNote = null;
    this.store.addEvent(a.service, a.alertId, simTs, 'reopened', null, { from: prev, why });
  }

  /** arl/<svc>/events/alert from a service. Returns null for no-op duplicates. */
  ingest(service: AlertService, p: AlertPayload): AlertChange | null {
    const simTs = p.ts;
    const existing = this.store.get(service, p.alert_id);
    const fields = {
      type: p.type,
      entity: p.entity ?? null,
      value: p.value ?? null,
      limit: p.limit ?? null,
      unit: p.unit ?? null,
      message: p.message ?? '',
      metadata: p.metadata ?? {},
    };

    if (!existing) {
      const a = { ...this.blank(service, p.alert_id, p.type, p.severity), ...fields };
      if (p.state === 'raised') {
        a.raisedTs = simTs;
        this.store.save(a);
        this.store.addEvent(service, p.alert_id, simTs, 'raised', null, {
          severity: p.severity,
          value: a.value,
          limit: a.limit,
        });
        return this.emit(a, 'raised');
      }
      // a clear for an alert we never saw raised (raised before we connected)
      a.svcState = 'cleared';
      a.clearedTs = simTs;
      a.placeholder = true;
      a.metadata = { ...a.metadata, raised_before_capture: true };
      this.store.save(a);
      this.store.addEvent(service, p.alert_id, simTs, 'cleared', null, { raised_before_capture: true });
      return this.emit(a, 'cleared');
    }

    const a: AlertDTO = { ...existing, metadata: { ...existing.metadata } };
    if (p.state === 'raised') {
      const escalated = SEVERITY_RANK[p.severity] > SEVERITY_RANK[a.severity];
      const deescalated = SEVERITY_RANK[p.severity] < SEVERITY_RANK[a.severity];
      const reraised = a.svcState === 'cleared';
      const captured = a.placeholder;
      const prevSeverity = a.severity;
      const changed =
        escalated || deescalated || reraised || captured || a.value !== fields.value || a.message !== fields.message;
      if (!changed) return null;
      Object.assign(a, fields);
      a.metadata = { ...existing.metadata, ...fields.metadata };
      if (captured) delete a.metadata['raised_before_capture'];
      a.severity = p.severity;
      a.maxSeverity = maxSev(a.maxSeverity, p.severity);
      a.svcState = 'raised';
      a.placeholder = false;
      let action = 'updated';
      if (reraised) {
        a.raisedTs = simTs;
        a.clearedTs = null;
        action = 'reraised';
        this.reopen(a, simTs, 'reraised');
      } else if (a.raisedTs === null) {
        a.raisedTs = simTs;
      }
      if (escalated) {
        action = 'escalated';
        this.reopen(a, simTs, 'escalated');
      } else if (deescalated && !reraised) {
        action = 'deescalated';
      } else if (captured && !reraised) {
        action = 'captured';
      }
      this.store.save(a);
      if (action !== 'updated') {
        this.store.addEvent(service, a.alertId, simTs, action, null, {
          from: prevSeverity,
          to: p.severity,
          value: a.value,
        });
      }
      return this.emit(a, action);
    }

    // cleared
    if (a.svcState === 'cleared') return null;
    a.svcState = 'cleared';
    a.clearedTs = simTs;
    if (fields.value !== null) a.value = fields.value;
    if (fields.message) a.message = fields.message;
    this.store.save(a);
    this.store.addEvent(service, a.alertId, simTs, 'cleared', null, { value: a.value });
    return this.emit(a, 'cleared');
  }

  /** Retained arl/<svc>/global/state/active_alerts: fill gaps from before we connected and missed clears. */
  reconcile(service: AlertService, activeIds: string[], simTs: number | null): AlertChange[] {
    const changes: AlertChange[] = [];
    const active = new Set(activeIds);
    for (const id of activeIds) {
      const existing = this.store.get(service, id);
      if (existing && existing.svcState === 'raised') continue;
      if (existing && existing.svcState === 'cleared' && existing.opState !== 'resolved') {
        // still active according to the service: we missed the re-raise
        const a = { ...existing, svcState: 'raised' as const, clearedTs: null };
        this.store.save(a);
        this.store.addEvent(service, id, simTs, 'reconciled', null, { svc_state: 'raised' });
        changes.push(this.emit(a, 'reconciled'));
        continue;
      }
      if (existing) continue; // resolved by an operator while still raised: leave it resolved
      const { type, entity } = decodeAlertId(service, id);
      const a = this.blank(service, id, type, DEFAULT_SEVERITY[type] ?? 'warning');
      a.entity = entity;
      a.placeholder = true;
      a.message = 'Raised before capture — details unknown until the service re-publishes it';
      a.metadata = { raised_before_capture: true, severity_unknown: true };
      this.store.save(a);
      this.store.addEvent(service, id, simTs, 'reconciled_placeholder', null, { raised_before_capture: true });
      changes.push(this.emit(a, 'reconciled_placeholder'));
    }
    for (const a of this.store.openForService(service)) {
      if (a.svcState !== 'raised' || active.has(a.alertId)) continue;
      const c = { ...a, svcState: 'cleared' as const, clearedTs: simTs };
      this.store.save(c);
      this.store.addEvent(service, a.alertId, simTs, 'cleared_by_reconcile', null, {});
      changes.push(this.emit(c, 'cleared_by_reconcile'));
    }
    return changes;
  }

  /** Fills a placeholder with its original raise event from the ARL API backlog (labelled as such). */
  fillFromBacklog(service: AlertService, p: AlertPayload): boolean {
    const existing = this.store.get(service, p.alert_id);
    if (!existing || !existing.placeholder || p.state !== 'raised') return false;
    const a: AlertDTO = {
      ...existing,
      type: p.type,
      entity: p.entity ?? existing.entity,
      severity: p.severity,
      maxSeverity: p.severity, // the placeholder's severity was only a guess
      value: p.value ?? null,
      limit: p.limit ?? null,
      unit: p.unit ?? null,
      message: p.message ?? existing.message,
      metadata: { ...(p.metadata ?? {}), raised_before_capture: true, details_source: 'api_backlog' },
      raisedTs: p.ts,
      placeholder: false,
    };
    this.store.save(a);
    this.store.addEvent(service, a.alertId, p.ts, 'details_from_backlog', null, { severity: p.severity, raised_ts: p.ts });
    this.emit(a, 'details_from_backlog');
    return true;
  }

  private platformBase(subject: string, type: string): string {
    return `platform-${subject}-${type}`;
  }

  private currentPlatform(base: string): AlertDTO | null {
    let best: AlertDTO | null = null;
    for (const a of this.store.openForService('platform')) {
      if (a.alertId.startsWith(`${base}-`) && /^\d+$/.test(a.alertId.slice(base.length + 1))) {
        if (!best || a.alertId > best.alertId) best = a;
      }
    }
    return best;
  }

  raisePlatform(spec: PlatformAlertSpec, simTs: number | null): AlertChange | null {
    const base = this.platformBase(spec.subject, spec.type);
    const current = this.currentPlatform(base);
    const metadata = { subject: spec.subject, ...(spec.metadata ?? {}) };
    if (current && current.svcState === 'raised') {
      const escalated = SEVERITY_RANK[spec.severity] > SEVERITY_RANK[current.severity];
      if (!escalated && current.value === (spec.value ?? null) && current.message === spec.message) return null;
      const a: AlertDTO = {
        ...current,
        severity: spec.severity,
        maxSeverity: maxSev(current.maxSeverity, spec.severity),
        value: spec.value ?? null,
        message: spec.message,
        metadata,
      };
      if (escalated) {
        this.reopen(a, simTs ?? 0, 'escalated');
        this.store.addEvent('platform', a.alertId, simTs, 'escalated', null, {
          from: current.severity,
          to: spec.severity,
        });
      }
      this.store.save(a);
      return this.emit(a, escalated ? 'escalated' : 'updated');
    }
    if (current && current.svcState === 'cleared') {
      const a: AlertDTO = {
        ...current,
        svcState: 'raised',
        clearedTs: null,
        raisedTs: simTs,
        severity: spec.severity,
        maxSeverity: maxSev(current.maxSeverity, spec.severity),
        value: spec.value ?? null,
        message: spec.message,
        metadata,
      };
      this.reopen(a, simTs ?? 0, 'reraised');
      this.store.save(a);
      this.store.addEvent('platform', a.alertId, simTs, 'reraised', null, { severity: spec.severity });
      return this.emit(a, 'reraised');
    }
    let n = this.counters.get(base);
    if (n === undefined) n = this.store.maxCounter('platform', base);
    n += 1;
    this.counters.set(base, n);
    const id = `${base}-${String(n).padStart(4, '0')}`;
    const a = this.blank('platform', id, spec.type, spec.severity);
    Object.assign(a, {
      entity: spec.entity ?? null,
      value: spec.value ?? null,
      limit: spec.limit ?? null,
      unit: spec.unit ?? null,
      message: spec.message,
      metadata,
      raisedTs: simTs,
    });
    this.store.save(a);
    this.store.addEvent('platform', id, simTs, 'raised', null, { severity: spec.severity, value: a.value });
    return this.emit(a, 'raised');
  }

  clearPlatform(subject: string, type: string, simTs: number | null): AlertChange | null {
    const current = this.currentPlatform(this.platformBase(subject, type));
    if (!current || current.svcState !== 'raised') return null;
    const a: AlertDTO = { ...current, svcState: 'cleared', clearedTs: simTs };
    this.store.save(a);
    this.store.addEvent('platform', a.alertId, simTs, 'cleared', null, {});
    return this.emit(a, 'cleared');
  }

  /** Caller must have verified the researcher for this alert's service first. */
  acknowledge(
    service: string,
    alertId: string,
    researcher: VerifiedResearcher,
    note: string | null,
    simTs: number | null,
  ): WorkflowResult {
    const a0 = this.store.get(service, alertId);
    if (!a0) return { ok: false, code: 'not_found', message: 'No such alert.' };
    if (a0.opState === 'resolved') return { ok: false, code: 'already_resolved', message: 'Alert is already resolved.' };
    if (a0.opState === 'acked') return { ok: false, code: 'already_acked', message: 'Alert is already acknowledged.' };
    const cleanNote = note?.trim() ? note.trim().slice(0, NOTE_MAX) : null;
    const a: AlertDTO = {
      ...a0,
      opState: 'acked',
      ackTs: simTs,
      ackBy: researcher.code,
      ackName: researcher.name,
      ackNote: cleanNote,
    };
    this.store.save(a);
    this.store.addEvent(a.service, a.alertId, simTs, 'acked', researcher.code, {
      name: researcher.name,
      note: cleanNote,
    });
    this.emit(a, 'acked');
    return { ok: true, alert: a };
  }

  resolve(
    service: string,
    alertId: string,
    researcher: VerifiedResearcher,
    note: string,
    simTs: number | null,
  ): WorkflowResult {
    const a0 = this.store.get(service, alertId);
    if (!a0) return { ok: false, code: 'not_found', message: 'No such alert.' };
    if (a0.opState === 'resolved') return { ok: false, code: 'already_resolved', message: 'Alert is already resolved.' };
    if (a0.opState !== 'acked') {
      return { ok: false, code: 'not_acked', message: 'Acknowledge the alert before resolving it.' };
    }
    const cleanNote = note.trim().slice(0, NOTE_MAX);
    if (cleanNote.length < 3) {
      return { ok: false, code: 'note_required', message: 'Describe how the alert was handled (at least 3 characters).' };
    }
    const a: AlertDTO = {
      ...a0,
      opState: 'resolved',
      resolvedTs: simTs,
      resolvedBy: researcher.code,
      resolvedName: researcher.name,
      resolutionNote: cleanNote,
    };
    this.store.save(a);
    this.store.addEvent(a.service, a.alertId, simTs, 'resolved', researcher.code, {
      name: researcher.name,
      note: cleanNote,
      svc_state: a.svcState,
    });
    this.emit(a, 'resolved');
    return { ok: true, alert: a };
  }
}
