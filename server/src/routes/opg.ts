// OPG REST: the live plant snapshot, the history the page draws and the refuel markers.
// Mounted by the plugin itself (see OpgPlugin.routes), so the paths stay next to the plugin's data.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OpgPlugin } from '../plugins/opg/index.js';

const HoursQuery = z.object({ hours: z.coerce.number().min(0.05).max(24 * 14).default(6) });

export function opgRoutes(app: FastifyInstance, plugin: OpgPlugin): void {
  app.get('/api/opg', async () => plugin.plant());

  app.get('/api/opg/trend', async (req) => {
    const { hours } = HoursQuery.parse(req.query);
    return plugin.trend(hours);
  });

  app.get('/api/opg/refuels', async () => ({ refuels: plugin.refuelList() }));
}
