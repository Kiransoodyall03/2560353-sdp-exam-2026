// LWM REST: the live network snapshot, the interpolated map field (variable + time, so replay scrubs),
// the campus outline, per-site history and the strike list. Mounted by the plugin (see LwmPlugin.routes)
// so the paths stay next to the plugin's data, same as the RTA and OPG routes.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAP_VARIABLE_IDS, type LwmPlugin } from '../plugins/lwm/index.js';

const SiteIdParam = z.object({ id: z.string().regex(/^lwm-[1-5]$/) });
const MapQuery = z.object({
  var: z.string().optional(),
  ts: z.coerce.number().int().optional(),
  cols: z.coerce.number().int().min(4).max(200).default(48),
  rows: z.coerce.number().int().min(4).max(200).default(40),
});
const HoursQuery = z.object({ hours: z.coerce.number().min(0.05).max(24 * 14).default(1) });

export function lwmRoutes(app: FastifyInstance, plugin: LwmPlugin): void {
  app.get('/api/lwm', async () => plugin.network());

  app.get('/api/lwm/variables', async () => ({ variables: MAP_VARIABLE_IDS }));

  app.get('/api/lwm/map', async (req) => {
    const q = MapQuery.parse(req.query);
    await plugin.ensureGeo();
    return plugin.map(q.var ?? 'temperature_k', q.ts ?? null, q.cols, q.rows);
  });

  app.get('/api/lwm/geojson', async (req, reply) => {
    await plugin.ensureGeo();
    const doc = plugin.geojsonDoc();
    if (!doc) return reply.code(404).send({ error: 'not_found', detail: 'arl.geojson' });
    return reply.type('application/geo+json').header('cache-control', 'public, max-age=3600').send(doc);
  });

  app.get('/api/lwm/lightning', async (req) => {
    const { hours } = HoursQuery.parse(req.query);
    return { strikes: plugin.strikes(hours) };
  });

  app.get('/api/lwm/sites/:id/history', async (req, reply) => {
    const { id } = SiteIdParam.parse(req.params);
    const { hours } = HoursQuery.parse(req.query);
    const out = plugin.siteHistory(id, hours);
    if (!out) return reply.code(404).send({ error: 'not_found', detail: 'site' });
    return out;
  });
}
