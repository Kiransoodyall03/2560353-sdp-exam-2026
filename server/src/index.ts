// Entry point: load .env (local only), validate config, open SQLite, connect MQTT, serve HTTP.
import 'dotenv/config';
import { createServer, registerRoutes } from './app.js';
import { ArlApiClient } from './arl-api/client.js';
import { loadConfig } from './config.js';
import { ScheduleRunner } from './commands/schedules.js';
import { Platform } from './core/platform.js';
import { openDb } from './db/index.js';
import { connectBroker } from './mqtt/client.js';
import { createGenericPlugin } from './plugins/generic.js';
import { createOpgPlugin } from './plugins/opg/index.js';
import { createRtaPlugin } from './plugins/rta/index.js';

async function main() {
  const cfg = loadConfig();
  const app = await createServer(cfg);
  const db = openDb(cfg.dbPath);
  const platform = new Platform({
    db,
    api: new ArlApiClient(cfg.api.baseUrl),
    log: app.log,
    plugins: [createRtaPlugin(), createGenericPlugin('lwm'), createOpgPlugin()],
  });
  await registerRoutes(app, platform);

  platform.start();
  const mqtt = connectBroker(
    cfg.mqtt,
    {
      onMessage: (topic, payload, retained) => platform.handleMessage(topic, payload, retained),
      onState: (connected, error) => platform.setBroker(connected, error),
    },
    app.log,
  );

  // controls leave the platform only through this publisher, and only while the broker is up
  platform.commands.setPublisher((topic, payload) => {
    if (!platform.broker.connected) return false;
    mqtt.publish(topic, payload, { qos: 1 });
    return true;
  });

  const schedules = new ScheduleRunner({
    db,
    clock: platform.clock,
    log: app.log,
    commands: platform.commands,
    verify: async (code, service) => {
      const v = await platform.verifier.verify(code, service);
      return v.ok ? v.researcher : null;
    },
  });
  schedules.start();

  await app.listen({ host: cfg.server.host, port: cfg.server.port });
  app.log.info({ broker: `${cfg.mqtt.host}:${cfg.mqtt.port}`, db: cfg.dbPath }, 'ARL platform started');

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, 'shutting down');
    schedules.stop();
    platform.commands.dispose();
    mqtt.end(true);
    platform.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
