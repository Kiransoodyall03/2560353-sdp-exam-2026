// MQTT connection: subscribe arl/#, reconnect every second, resubscribe on every (re)connect.
import { connect, type MqttClient } from 'mqtt';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { SUBSCRIBE_ALL } from '../core/topics.js';
import type { Logger } from '../log.js';

export interface BrokerHandlers {
  onMessage(topic: string, payload: Buffer, retained: boolean): void;
  onState(connected: boolean, error: string | null): void;
}

export function connectBroker(cfg: Config['mqtt'], h: BrokerHandlers, log: Logger): MqttClient {
  const client = connect(cfg.url, {
    clientId: `arl-platform-${randomBytes(4).toString('hex')}`,
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    reconnectPeriod: 1000,
    connectTimeout: 10_000,
    clean: true,
    resubscribe: true,
    keepalive: 30,
  });
  client.on('connect', () => {
    client.subscribe(SUBSCRIBE_ALL, { qos: 1 }, (err) => {
      if (err) log.error({ err: err.message }, 'subscribe failed');
      else log.info({ topic: SUBSCRIBE_ALL }, 'subscribed');
    });
    h.onState(true, null);
  });
  client.on('message', (topic, payload, packet) => h.onMessage(topic, payload, packet.retain === true));
  client.on('close', () => h.onState(false, null));
  client.on('offline', () => h.onState(false, 'offline'));
  client.on('error', (err) => {
    log.warn({ err: err.message }, 'mqtt error');
    h.onState(false, err.message);
  });
  return client;
}
