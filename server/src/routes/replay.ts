// Replay HTTP surface + the control lockout hook. Everything here is read-only over our own stored
// history: the engine folds raw_messages through the same parse + reducer code the live path uses, so a
// session shows exactly the state the platform had at sim time t (never the ARL API backlog).
//
// Registration order matters. replayRoutes() must run FIRST in registerRoutes (see app.ts): a Fastify
// onRequest hook only guards the routes registered after it in the same context, so adding the hook here
// before commandRoutes / presetRoutes / scheduleRoutes lets us refuse any control request that carries the
// `x-replay-session` header with a 409 — without touching the command routes themselves.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Platform } from '../core/platform.js';
import { ReplayEngine, ReplayError } from '../replay/engine.js';
import { CONTROL_PREFIXES, REPLAY_HEADER, SPEEDS, type Speed } from '../replay/types.js';

/** Session ids are `rp_` + a short base36 token (see ReplayEngine.newId). */
const IdParam = z.object({ id: z.string().regex(/^rp_[0-9a-z]{4,20}$/) });

const SpeedSchema = z.custom<Speed>(
  (v: unknown): v is Speed => typeof v === 'number' && (SPEEDS as readonly number[]).includes(v),
  { message: `speed must be one of ${SPEEDS.join(', ')}` },
);

const CreateBody = z.object({ t: z.number(), speed: SpeedSchema.optional() }).strict();
const SeekBody = z.object({ t: z.number() }).strict();
const SpeedBody = z.object({ speed: SpeedSchema }).strict();
const StepBody = z.object({ direction: z.union([z.literal(1), z.literal(-1)]) }).strict();
const MarkersQuery = z.object({ from: z.coerce.number(), to: z.coerce.number() }).strict();

/** Runs an engine call, mapping a ReplayError to {error, detail} at its status; anything else rethrows. */
function run<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ReplayError) return reply.code(err.status).send({ error: err.code, detail: err.message });
    throw err;
  }
}

export function replayRoutes(app: FastifyInstance, platform: Platform): void {
  const engine = new ReplayEngine({
    db: platform.db,
    plugins: platform.plugins,
    api: platform.api,
    sse: platform.sse,
  });

  // Read-only replay: a request carrying the session header may not drive any live control route.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.headers[REPLAY_HEADER]) return;
    const url = req.url.split('?')[0] ?? req.url;
    if (CONTROL_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`))) {
      return reply.code(409).send({ error: 'replay_mode', detail: 'Replay mode: controls are disabled.' });
    }
  });

  // ---- session lifecycle ---------------------------------------------------------------
  // POST /api/replay {t, speed?} → the created session (t is clamped to the stored range).
  app.post('/api/replay', async (req, reply) => {
    const body = CreateBody.parse(req.body);
    return run(reply, () => engine.create(body.t, body.speed ?? 1));
  });

  // POST /api/replay/:id/seek {t} → rebuild from the nearest snapshot ≤ t and fold forward; returns session.
  app.post('/api/replay/:id/seek', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = SeekBody.parse(req.body);
    return run(reply, () => engine.seek(id, body.t));
  });

  // POST /api/replay/:id/play → start the 100 ms tick (t advances TICK_MS × speed); returns session.
  app.post('/api/replay/:id/play', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    return run(reply, () => engine.play(id));
  });

  // POST /api/replay/:id/pause → stop the tick, keep t; returns session.
  app.post('/api/replay/:id/pause', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    return run(reply, () => engine.pause(id));
  });

  // POST /api/replay/:id/speed {speed} → set playback speed (one of SPEEDS); returns session.
  app.post('/api/replay/:id/speed', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = SpeedBody.parse(req.body);
    return run(reply, () => engine.setSpeed(id, body.speed));
  });

  // POST /api/replay/:id/step {direction: 1|-1} → move to the next/previous raw-message ts, then pause.
  app.post('/api/replay/:id/step', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = StepBody.parse(req.body);
    return run(reply, () => engine.step(id, body.direction));
  });

  // DELETE /api/replay/:id → drop the session (idempotent). 204, no body.
  app.delete('/api/replay/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    engine.remove(id);
    return reply.code(204).send();
  });

  // ---- reads ---------------------------------------------------------------------------
  // GET /api/replay/:id/state → per-service state DTOs (same shapes the live endpoints return) + alerts at t.
  app.get('/api/replay/:id/state', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    return run(reply, () => engine.state(id));
  });

  // GET /api/replay/range → earliest / latest stored sim ts, overall and per service.
  app.get('/api/replay/range', async () => engine.range());

  // GET /api/replay/markers?from&to → alert events, commands and RTA scan start/end in the window.
  app.get('/api/replay/markers', async (req) => {
    const q = MarkersQuery.parse(req.query);
    return engine.markers(q.from, q.to);
  });
}
