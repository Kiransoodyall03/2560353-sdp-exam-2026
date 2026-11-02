// Presets: named step sequences a plugin registers at start-up. Running one verifies the researcher
// for the preset's service, then re-checks every safeguard as the steps are submitted in order.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Platform } from '../core/platform.js';
import type { ResearcherGuard } from './researcher.js';

const ListQuery = z.object({ service: z.enum(['rta', 'lwm', 'opg']).optional() }).strict();
const IdParam = z.object({ id: z.string().min(1).max(80) });

export function presetRoutes(app: FastifyInstance, platform: Platform, guard: ResearcherGuard): void {
  app.get('/api/presets', async (req) => {
    const { service } = ListQuery.parse(req.query);
    return platform.commands.presetsFor(service);
  });

  app.post('/api/presets/:id/run', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const preset = platform.commands.findPreset(id);
    if (!preset) return reply.code(404).send({ error: 'not_found', detail: 'preset' });
    const researcher = await guard.require(req, reply, preset.service);
    if (!researcher) return reply;
    const r = await platform.commands.runPreset(id, researcher, 'preset');
    return reply.code(r.ok ? 202 : 409).send({ ok: r.ok, preset: id, results: r.results });
  });
}
