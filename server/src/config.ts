// The only place that reads process.env (exam rule 1). Callers get a frozen, validated Config.
import { z } from 'zod';

const required = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .trim()
    .min(1, `${name} is required`);

const port = (name: string) =>
  required(name).transform((v, ctx) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be a TCP port` });
      return z.NEVER;
    }
    return n;
  });

const EnvSchema = z.object({
  MQTT_BROKER_ADDRESS: required('MQTT_BROKER_ADDRESS'),
  MQTT_BROKER_PORT: port('MQTT_BROKER_PORT'),
  MQTT_BROKER_USER: z.string().optional().default(''),
  MQTT_BROKER_PASSWORD: z.string().optional().default(''),
  ARL_API_ADDRESS: required('ARL_API_ADDRESS'),
  ARL_API_PORT: port('ARL_API_PORT'),
  // Our own server. Defaults are documented in .env.example.
  SERVER_HOST: z.string().trim().min(1).optional().default('127.0.0.1'),
  SERVER_PORT: z.string().optional().default('4000').pipe(port('SERVER_PORT')),
  WEB_ORIGIN: z.string().trim().optional().default('http://localhost:5173'),
  DB_PATH: z.string().trim().min(1).optional().default('server/data/arl.sqlite'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional().default('info'),
});

export interface Config {
  mqtt: { host: string; port: number; username: string; password: string; url: string };
  api: { baseUrl: string };
  server: { host: string; port: number; webOrigins: string[] };
  dbPath: string;
  logLevel: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join('; ');
    throw new ConfigError(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  return Object.freeze({
    mqtt: {
      host: e.MQTT_BROKER_ADDRESS,
      port: e.MQTT_BROKER_PORT,
      username: e.MQTT_BROKER_USER,
      password: e.MQTT_BROKER_PASSWORD,
      url: `mqtt://${e.MQTT_BROKER_ADDRESS}:${e.MQTT_BROKER_PORT}`,
    },
    api: { baseUrl: `http://${e.ARL_API_ADDRESS}:${e.ARL_API_PORT}/v1` },
    server: {
      host: e.SERVER_HOST,
      port: e.SERVER_PORT,
      webOrigins: e.WEB_ORIGIN.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    dbPath: e.DB_PATH,
    logLevel: e.LOG_LEVEL,
  });
}
