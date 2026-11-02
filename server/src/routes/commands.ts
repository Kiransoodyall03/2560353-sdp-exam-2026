// Controls: list the specs a service exposes, submit a command through the full pipeline, and read
// the command history / one command. Every submit verifies the researcher before anything happens.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { explainCommandReason } from '../../../shared/commands.js';
import type { Platform } from '../core/platform.js';
import type { ResearcherGuard } from './researcher.js';

const ServiceParam = z.object({ service: z.enum(['rta', 'lwm', 'opg']) });
const IdParam = z.object({ id: z.string().min(1).max(120) });

const SubmitBody = z
  .object({
    service: z.enum(['rta', 'lwm', 'opg']),
    entity: z.string().min(1).max(64),
    control: z.string().min(1).max(64),
    value: z.unknown(),
    /** Echoed back from a 428 confirm_required response. */
    confirmToken: z.string().min(1).max(200).optional(),
  })
  .strict();

const ListQuery = z
  .object({
    service: z.enum(['rta', 'lwm', 'opg']).optional(),
    entity: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export function commandRoutes(app: FastifyInstance, platform: Platform, guard: ResearcherGuard): void {
  app.get('/api/commands/specs/:service', async (req) => {
    const { service } = ServiceParam.parse(req.params);
    return { service, controls: platform.commands.specsFor(service) };
  });

  /** History; a bare array because the UI and curl both read it by index. */
  app.get('/api/commands', async (req) => {
    const q = ListQuery.parse(req.query);
    return platform.commands.history(q);
  });

  app.get('/api/commands/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const command = platform.commands.get(id);
    if (!command) return reply.code(404).send({ error: 'not_found', detail: 'command' });
    return command;
  });

  app.post('/api/commands', async (req, reply) => {
    const body = SubmitBody.parse(req.body);
    // rule 5: verify for the command's service before the value is even inspected by the plugin
    const researcher = await guard.require(req, reply, body.service);
    if (!researcher) return reply;
    const r = platform.commands.submit({
      service: body.service,
      entity: body.entity,
      control: body.control,
      value: body.value,
      researcher,
      confirmToken: body.confirmToken ?? null,
    });
    if (!r.ok) {
      return reply.code(r.status).send({
        error: r.error,
        detail: r.detail || explainCommandReason(r.error, { service: body.service, control: body.control }),
        ...(r.facts ? { facts: r.facts } : {}),
        ...(r.token ? { token: r.token, expiresAtTs: r.expiresAtTs } : {}),
      });
    }
    return reply.code(202).send({ command: platform.commands.get(r.commandId) });
  });
}
