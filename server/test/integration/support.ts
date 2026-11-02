// Shared helpers for the integration suite (`npm run test:int`).
//
// These tests run against the real podman ARL stack (broker + API + services). To exercise the whole
// platform pipeline end to end we boot our own server in-process — exactly as server/src/index.ts does,
// but on an in-memory database and an ephemeral HTTP port — wired to the live broker and ARL API. A
// command then travels: HTTP -> researcher guard (verified via the ARL API) -> publish on
// arl/<svc>/cmd/<entity>/<control> -> the service acks on arl/<svc>/ack/<command_id> -> our ack tracker
// -> GET /api/commands/<id>. Nothing here hard-codes a host, port or code (exam rule 1).
import 'dotenv/config';
import type { FastifyInstance } from 'fastify';
import mqtt from 'mqtt';
import { createServer, registerRoutes } from '../../src/app.js';
import { ArlApiClient } from '../../src/arl-api/client.js';
import { loadConfig, type Config } from '../../src/config.js';
import { Platform } from '../../src/core/platform.js';
import { openDb, type Db } from '../../src/db/index.js';
import { connectBroker } from '../../src/mqtt/client.js';
import { createGenericPlugin } from '../../src/plugins/generic.js';
import { createOpgPlugin } from '../../src/plugins/opg/index.js';
import { createRtaPlugin } from '../../src/plugins/rta/index.js';

export interface ProbeResult {
  ok: boolean;
  /** Why the stack is unusable (null when ok). Printed as the skip reason. */
  reason: string | null;
  /** Parsed config, or null when .env is missing/invalid. */
  cfg: Config | null;
}

/** Loads .env config and probes the broker once so the whole suite can skip cleanly without a stack. */
export async function probeStack(timeoutMs = 4000): Promise<ProbeResult> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    return { ok: false, cfg: null, reason: `invalid or missing config (.env): ${msg(err)}` };
  }
  const reachable = await canConnect(cfg.mqtt.url, cfg.mqtt.username, cfg.mqtt.password, timeoutMs);
  return reachable
    ? { ok: true, reason: null, cfg }
    : { ok: false, cfg, reason: `MQTT broker unreachable at ${cfg.mqtt.url} (start the podman stack first)` };
}

function canConnect(url: string, username: string, password: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const client = mqtt.connect(url, {
      ...(username ? { username, password } : {}),
      connectTimeout: timeoutMs,
      reconnectPeriod: 0,
    });
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true);
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs + 500);
    client.once('connect', () => finish(true));
    client.once('error', () => finish(false));
  });
}

export interface TestStack {
  cfg: Config;
  baseUrl: string;
  app: FastifyInstance;
  platform: Platform;
  db: Db;
  mqtt: mqtt.MqttClient;
  close(): Promise<void>;
}

/** Boots the platform (in-memory DB, ephemeral port) against the live broker + ARL API. */
export async function bootPlatform(cfg: Config): Promise<TestStack> {
  const app = await createServer(cfg, { logger: false });
  const db = openDb(':memory:');
  const platform = new Platform({
    db,
    api: new ArlApiClient(cfg.api.baseUrl),
    log: app.log,
    plugins: [createRtaPlugin(), createGenericPlugin('lwm'), createOpgPlugin()],
  });
  await registerRoutes(app, platform);
  platform.start();

  // Once close() begins, the broker still emits 'close'/'offline'; this flag stops those from reaching the
  // platform, whose broker_disconnected alert write would otherwise hit the already-closed in-memory DB.
  let closed = false;
  const client = connectBroker(
    cfg.mqtt,
    {
      onMessage: (topic, payload, retained) => {
        if (!closed) platform.handleMessage(topic, payload, retained);
      },
      onState: (connected, error) => {
        if (!closed) platform.setBroker(connected, error);
      },
    },
    app.log,
  );
  // controls leave the platform only through this publisher, and only while the broker is up
  platform.commands.setPublisher((topic, payload) => {
    if (closed || !platform.broker.connected) return false;
    client.publish(topic, payload, { qos: 1 });
    return true;
  });

  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    cfg,
    baseUrl,
    app,
    platform,
    db,
    mqtt: client,
    async close() {
      closed = true; // stop feeding the platform before anything is torn down
      platform.commands.dispose();
      platform.stop();
      await client.endAsync();
      await app.close();
      db.close();
    },
  };
}

/** Polls `check` until it returns a truthy value, or null once `timeoutMs` has elapsed. */
export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs: number, intervalMs = 250): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
