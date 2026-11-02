import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Platform } from './core/platform.js';
import { REDACT_PATHS } from './log.js';
import { alertRoutes } from './routes/alerts.js';
import { coreRoutes } from './routes/core.js';

const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

/** HTTP server with CORS (web origin only) and uniform {error, detail} errors. Routes come later. */
export async function createServer(
  cfg: Pick<Config, 'server' | 'logLevel'>,
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: cfg.logLevel, redact: REDACT_PATHS },
    bodyLimit: 64 * 1024,
    trustProxy: false,
  });

  await app.register(cors, {
    origin: cfg.server.webOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'x-researcher-code'],
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'invalid_request',
        detail: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) app.log.error({ err }, 'request failed');
    return reply
      .code(status)
      .send({ error: status >= 500 ? 'internal' : 'invalid_request', detail: status >= 500 ? null : err.message });
  });
  return app;
}

export async function registerRoutes(app: FastifyInstance, platform: Platform): Promise<void> {
  coreRoutes(app, platform);
  alertRoutes(app, platform);
  for (const p of platform.plugins.values()) p.routes?.(app);

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', detail: null });
      return reply.sendFile('index.html');
    });
  }
}
