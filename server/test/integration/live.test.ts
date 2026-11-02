// Live checks against the running ARL stack (broker + API). Endpoints come from .env via loadConfig only.
// The whole suite skips cleanly when the broker is unreachable (no stack) — see probeStack() in support.ts.
import 'dotenv/config';
import mqtt from 'mqtt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArlApiClient } from '../../src/arl-api/client.js';
import { parseMessage } from '../../src/core/parse.js';
import { SERVICES } from '../../../shared/types.js';
import { probeStack } from './support.js';

const probe = await probeStack();
if (!probe.ok) console.warn(`[test:int] skipping live ARL stack checks: ${probe.reason}`);

describe.skipIf(!probe.ok)('live ARL stack', () => {
  const cfg = probe.cfg!;
  let client: mqtt.MqttClient;
  const seen = new Map<string, string>();

  beforeAll(async () => {
    client = mqtt.connect(cfg.mqtt.url, {
      ...(cfg.mqtt.username ? { username: cfg.mqtt.username, password: cfg.mqtt.password } : {}),
      connectTimeout: 5000,
      reconnectPeriod: 0,
    });
    client.on('message', (topic, payload) => {
      const p = parseMessage(topic, payload, Date.now(), true);
      if (p.kind === 'topology') seen.set(p.service, p.topology.version);
    });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
    await client.subscribeAsync('arl/+/$topology');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !SERVICES.every((s) => seen.has(s))) await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    await client?.endAsync();
  });

  it('publishes retained $topology for rta, lwm and opg', () => {
    for (const s of SERVICES) expect(seen.has(s), `${s} $topology`).toBe(true);
  });

  it('serves the ARL API health and target catalogue', async () => {
    const api = new ArlApiClient(cfg.api.baseUrl);
    expect((await api.health()).status).toBeTruthy();
    const targets = await api.targets();
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t.id).toMatch(/^tgt-[a-z]{3}$/);
  });
});
