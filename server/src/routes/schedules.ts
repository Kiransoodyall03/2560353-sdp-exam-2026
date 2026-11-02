// Schedules: run a preset (or an explicit step list) at a simulated time. The row is recorded only
// after the researcher is verified; ScheduleRunner re-verifies and re-checks safeguards when it fires.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PresetStepDTO } from '../../../shared/commands.js';
import type { Platform } from '../core/platform.js';
import { getScheduleRow, insertSchedule, listSchedules, scheduleDTO, setScheduleState } from '../db/commands.js';
import type { ResearcherGuard } from './researcher.js';

const ListQuery = z
  .object({
    service: z.enum(['rta', 'lwm', 'opg']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const CreateBody = z
  .object({
    service: z.enum(['rta', 'lwm', 'opg']),
    name: z.string().min(1).max(80),
    presetId: z.string().min(1).max(80).optional(),
    steps: z
      .array(
        z
          .object({ entity: z.string().min(1).max(64), control: z.string().min(1).max(64), value: z.unknown() })
          .strict(),
      )
      .min(1)
      .max(20)
      .optional(),
    atSimTs: z.number().int().positive(),
  })
  .strict();

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function scheduleRoutes(app: FastifyInstance, platform: Platform, guard: ResearcherGuard): void {
  app.get('/api/schedules', async (req) => {
    const q = ListQuery.parse(req.query);
    return listSchedules(platform.db, q.service, q.limit ?? 50);
  });

  app.post('/api/schedules', async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const now = platform.clock.now(body.service);
    if (now !== null && body.atSimTs <= now) {
      return reply.code(400).send({ error: 'invalid_value', detail: 'The scheduled time is in the past' });
    }
    let steps: PresetStepDTO[] = (body.steps ?? []).map((s) => ({ entity: s.entity, control: s.control, value: s.value ?? null }));
    if (body.presetId) {
      const preset = platform.commands.findPreset(body.presetId);
      if (!preset) return reply.code(404).send({ error: 'unknown_preset', detail: `No preset "${body.presetId}"` });
      if (preset.service !== body.service) {
        return reply.code(400).send({ error: 'invalid_value', detail: `Preset "${preset.id}" belongs to ${preset.service}` });
      }
      steps = preset.steps;
    }
    if (steps.length === 0) {
      return reply.code(400).send({ error: 'invalid_value', detail: 'Give a preset id or at least one step' });
    }
    const researcher = await guard.require(req, reply, body.service);
    if (!researcher) return reply;
    const id = insertSchedule(platform.db, {
      service: body.service,
      name: body.name,
      presetId: body.presetId ?? null,
      steps,
      atSimTs: body.atSimTs,
      researcher: researcher.code,
      wallTs: Date.now(),
    });
    const row = getScheduleRow(platform.db, id);
    platform.log.info({ schedule: id, service: body.service, steps: steps.length }, 'schedule created');
    return reply.code(202).send({ schedule: row ? scheduleDTO(row) : null });
  });

  app.post('/api/schedules/:id/cancel', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const row = getScheduleRow(platform.db, id);
    if (!row) return reply.code(404).send({ error: 'not_found', detail: 'schedule' });
    if (row.state !== 'pending') {
      return reply.code(409).send({ error: 'not_pending', detail: `This schedule is already ${row.state}` });
    }
    if (!['rta', 'lwm', 'opg'].includes(row.service)) {
      return reply.code(400).send({ error: 'invalid_request', detail: 'unknown service' });
    }
    const researcher = await guard.require(req, reply, row.service as 'rta' | 'lwm' | 'opg');
    if (!researcher) return reply;
    setScheduleState(platform.db, id, 'cancelled', `Cancelled by ${researcher.name}`);
    const after = getScheduleRow(platform.db, id);
    return { schedule: after ? scheduleDTO(after) : null };
  });
}
