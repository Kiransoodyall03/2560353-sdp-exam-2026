import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SERVICES } from '../../../shared/types.js';
import type { Platform } from '../core/platform.js';

const Svc = z.object({ svc: z.enum(SERVICES) });
const Channel = z.object({ channel: z.string().regex(/^[a-z]+(:[A-Za-z0-9._-]{1,64})?$/) });

export function coreRoutes(app: FastifyInstance, platform: Platform): void {
  app.get('/api/health', async () => platform.platformHealth());
  app.get('/api/overview', async () => platform.overview());

  app.get('/api/topology/:svc', async (req, reply) => {
    const { svc } = Svc.parse(req.params);
    const t = platform.topology.get(svc);
    if (!t) return reply.code(404).send({ error: 'not_found', detail: 'no $topology received yet' });
    return t;
  });

  app.get('/api/services/:svc/state', async (req) => {
    const { svc } = Svc.parse(req.params);
    return { health: platform.serviceHealth(svc), state: platform.state.service(svc), topology: platform.topology.get(svc) };
  });

  app.get('/api/stream/:channel', (req, reply) => {
    const { channel } = Channel.parse(req.params);
    if (!platform.sse.knows(channel)) {
      void reply.code(404).send({ error: 'not_found', detail: 'unknown channel' });
      return;
    }
    platform.sse.handle(req, reply, channel, (req.query ?? {}) as Record<string, string>);
  });

  app.get('/api/targets', async (_req, reply) => {
    try {
      return await platform.api.targets();
    } catch {
      return reply.code(503).send({ error: 'api_unavailable', detail: 'ARL API unreachable' });
    }
  });

  app.get('/api/alert-limits/:svc', async (req, reply) => {
    const { svc } = Svc.parse(req.params);
    try {
      return await platform.api.alertLimits(svc);
    } catch {
      return reply.code(503).send({ error: 'api_unavailable', detail: 'ARL API unreachable' });
    }
  });
}
