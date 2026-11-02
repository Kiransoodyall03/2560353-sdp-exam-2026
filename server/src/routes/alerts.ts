// Alert workflow endpoints. Every ack/resolve is verified server-side (POST /v1/researchers/verify for the
// alert's service; platform alerts: any active researcher) BEFORE anything is recorded.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AlertService, CommandDTO, VerifyResponse } from '../../../shared/types.js';
import { NOTE_MAX } from '../alerts/workflow.js';
import { publicAlert, publicEvent } from '../alerts/public.js';
import { suggestedAction } from '../alerts/suggestions.js';
import type { Platform } from '../core/platform.js';
import { maskCode } from '../log.js';
import { FailureLimiter, VERIFY_MESSAGES, type VerifiedResearcher } from '../researchers/verify.js';

export const RESEARCHER_HEADER = 'x-researcher-code';
const ALERT_SERVICES = ['rta', 'lwm', 'opg', 'platform'] as const;

const KeyParams = z.object({
  service: z.enum(ALERT_SERVICES),
  alertId: z.string().min(1).max(200),
});
const AckBody = z.object({ note: z.string().max(NOTE_MAX).optional().nullable() }).strict();
const ResolveBody = z.object({ note: z.string().min(1).max(NOTE_MAX) }).strict();
const BulkBody = z
  .object({
    action: z.enum(['ack', 'resolve']),
    keys: z.array(z.string().min(3).max(220)).min(1).max(500),
    note: z.string().max(NOTE_MAX).optional().nullable(),
  })
  .strict();
const ListQuery = z.object({
  service: z.enum(ALERT_SERVICES).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  op: z.enum(['unacked', 'acked', 'resolved']).optional(),
  svc: z.enum(['raised', 'cleared']).optional(),
  includeResolved: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(20000).optional(),
});
const VerifyBody = z.object({ service: z.enum(ALERT_SERVICES) }).strict();

export function alertRoutes(app: FastifyInstance, platform: Platform): void {
  const limiter = new FailureLimiter(10, 60_000);

  /** Verifies the header code for a service; sends the error reply and returns null on failure. */
  async function requireResearcher(
    req: FastifyRequest,
    reply: FastifyReply,
    service: AlertService,
  ): Promise<VerifiedResearcher | null> {
    const blocked = limiter.blocked(req.ip);
    if (blocked) {
      void reply
        .code(429)
        .header('retry-after', String(blocked))
        .send({ error: 'rate_limited', detail: 'Too many failed researcher verifications. Wait and try again.' });
      return null;
    }
    const raw = req.headers[RESEARCHER_HEADER];
    const code = typeof raw === 'string' ? raw.trim() : '';
    if (!code) {
      void reply.code(401).send({ error: 'researcher_required', detail: 'A researcher code is required.' });
      return null;
    }
    const v = await platform.verifier.verify(code, service);
    if (v.ok) return v.researcher;
    if (v.reason === 'api_unavailable' || v.reason === 'rate_limited') {
      const r = reply.code(503);
      if (v.retryAfterS) r.header('retry-after', String(v.retryAfterS));
      void r.send({ error: v.reason, detail: VERIFY_MESSAGES[v.reason] });
      return null;
    }
    limiter.fail(req.ip);
    void reply.code(403).send({ error: `researcher_${v.reason}`, detail: VERIFY_MESSAGES[v.reason] });
    return null;
  }

  const simNow = () => platform.clock.globalNow();

  app.get('/api/alerts', async (req) => {
    const q = ListQuery.parse(req.query);
    const alerts = platform.alertStore.list({
      ...(q.service ? { service: q.service } : {}),
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.op ? { opState: q.op } : {}),
      ...(q.svc ? { svcState: q.svc } : {}),
      includeResolved: q.includeResolved === '1',
      ...(q.limit ? { limit: q.limit } : {}),
    });
    return { alerts: alerts.map(publicAlert), summary: platform.alertStore.summary() };
  });

  app.get('/api/alerts/summary', async () => platform.alertStore.summary());

  app.get('/api/alerts/:service/:alertId', async (req, reply) => {
    const { service, alertId } = KeyParams.parse(req.params);
    const alert = platform.alertStore.get(service, alertId);
    if (!alert) return reply.code(404).send({ error: 'not_found', detail: 'alert' });
    const cmdService = service === 'platform' ? String(alert.metadata['subject'] ?? '') : service;
    const from = (alert.raisedTs ?? alert.clearedTs ?? 0) - 15 * 60_000;
    const to = (alert.clearedTs ?? simNow() ?? Date.now()) + 5 * 60_000;
    const commands = platform.db
      .prepare(
        `SELECT * FROM commands WHERE service = ? AND requested_ts BETWEEN ? AND ? ORDER BY requested_ts DESC LIMIT 50`,
      )
      .all(cmdService, from, to) as Record<string, unknown>[];
    return {
      alert: publicAlert(alert),
      events: platform.alertStore.events(service, alertId).map(publicEvent),
      commands: commands.map(commandRow),
      suggestion: suggestedAction(alert.type),
    };
  });

  app.post('/api/alerts/:service/:alertId/ack', async (req, reply) => {
    const { service, alertId } = KeyParams.parse(req.params);
    const body = AckBody.parse(req.body ?? {});
    if (!platform.alertStore.get(service, alertId)) return reply.code(404).send({ error: 'not_found', detail: 'alert' });
    const researcher = await requireResearcher(req, reply, service);
    if (!researcher) return reply;
    const r = platform.alerts.acknowledge(service, alertId, researcher, body.note ?? null, simNow());
    if (!r.ok) return reply.code(409).send({ error: r.code, detail: r.message });
    return { alert: publicAlert(r.alert) };
  });

  app.post('/api/alerts/:service/:alertId/resolve', async (req, reply) => {
    const { service, alertId } = KeyParams.parse(req.params);
    const body = ResolveBody.parse(req.body ?? {});
    const existing = platform.alertStore.get(service, alertId);
    if (!existing) return reply.code(404).send({ error: 'not_found', detail: 'alert' });
    if (existing.opState !== 'acked') {
      return reply.code(409).send({ error: 'not_acked', detail: 'Acknowledge the alert before resolving it.' });
    }
    const researcher = await requireResearcher(req, reply, service);
    if (!researcher) return reply;
    const r = platform.alerts.resolve(service, alertId, researcher, body.note, simNow());
    if (!r.ok) return reply.code(409).send({ error: r.code, detail: r.message });
    return { alert: publicAlert(r.alert) };
  });

  app.post('/api/alerts/bulk', async (req, reply) => {
    const body = BulkBody.parse(req.body);
    if (body.action === 'resolve' && !(body.note && body.note.trim().length >= 3)) {
      return reply.code(400).send({ error: 'note_required', detail: 'Describe how the alerts were handled.' });
    }
    const keys = [...new Set(body.keys)];
    const parsed = keys.map((k) => {
      const i = k.indexOf(':');
      return { key: k, service: k.slice(0, i), alertId: k.slice(i + 1) };
    });
    const services = [...new Set(parsed.map((p) => p.service))];
    if (!services.every((s): s is (typeof ALERT_SERVICES)[number] => (ALERT_SERVICES as readonly string[]).includes(s))) {
      return reply.code(400).send({ error: 'invalid_request', detail: 'unknown service in keys' });
    }
    // verify once per service before touching anything
    const researchers = new Map<string, VerifiedResearcher>();
    for (const s of services) {
      const r = await requireResearcher(req, reply, s as AlertService);
      if (!r) return reply;
      researchers.set(s, r);
    }
    const results = parsed.map((p) => {
      const r = researchers.get(p.service)!;
      const res =
        body.action === 'ack'
          ? platform.alerts.acknowledge(p.service, p.alertId, r, body.note ?? null, simNow())
          : platform.alerts.resolve(p.service, p.alertId, r, body.note ?? '', simNow());
      return { key: p.key, ok: res.ok, error: res.ok ? null : res.code };
    });
    return { results, done: results.filter((r) => r.ok).length };
  });

  app.post('/api/verify', async (req, reply) => {
    const { service } = VerifyBody.parse(req.body);
    const blocked = limiter.blocked(req.ip);
    if (blocked) {
      return reply.code(429).header('retry-after', String(blocked)).send({ error: 'rate_limited', detail: 'Too many failed attempts.' });
    }
    const raw = req.headers[RESEARCHER_HEADER];
    const code = typeof raw === 'string' ? raw.trim() : '';
    const v = await platform.verifier.verify(code, service);
    if (!v.ok && v.reason !== 'api_unavailable' && v.reason !== 'rate_limited') limiter.fail(req.ip);
    const body: VerifyResponse = v.ok
      ? { valid: true, reason: null, name: v.researcher.name, service }
      : { valid: false, reason: v.reason, name: null, service, ...(v.retryAfterS ? { retryAfterS: v.retryAfterS } : {}) };
    return body;
  });
}

function commandRow(r: Record<string, unknown>): CommandDTO {
  let value: unknown = null;
  try {
    value = JSON.parse(String(r['value_json']));
  } catch {
    /* keep null */
  }
  return {
    commandId: String(r['command_id']),
    service: r['service'] as CommandDTO['service'],
    entity: String(r['entity']),
    control: String(r['control']),
    value,
    researcher: maskCode(String(r['researcher'])),
    requestedTs: Number(r['requested_ts']),
    state: String(r['state']),
    progress: (r['progress'] as number | null) ?? null,
    reason: (r['reason'] as string | null) ?? null,
    detail: (r['detail'] as string | null) ?? null,
    updatedTs: Number(r['updated_ts']),
  };
}
