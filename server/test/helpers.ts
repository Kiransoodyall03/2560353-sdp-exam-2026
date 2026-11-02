// Shared test helpers: real fixtures (cut from docs/samples.txt by `npm run fixtures`), in-memory DB, fetch mocks.
import { readFileSync } from 'node:fs';
import { openDb, type Db } from '../src/db/index.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);

export interface FixtureLine {
  topic: string;
  payload: string;
}

/** Lines of a fixture file in samples.txt format: `<topic> <payload>`. */
export function fixture(name: string): FixtureLine[] {
  return readFileSync(new URL(name, FIXTURES), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(' ');
      return i < 0 ? { topic: l, payload: '' } : { topic: l.slice(0, i), payload: l.slice(i + 1) };
    });
}

export const ALL_FIXTURES = ['topology.txt', 'rta-telemetry.txt', 'rta-state.txt', 'rta-events.txt', 'alerts.txt', 'lwm-opg.txt'];

export function memDb(): Db {
  return openDb(':memory:');
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Records calls and answers from a route table (first matching prefix wins). */
export function mockFetch(routes: [string, (init?: RequestInit) => Response | Promise<Response>][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, ...(init ? { init } : {}) });
    const r = routes.find(([prefix]) => url.includes(prefix));
    if (!r) throw new TypeError(`fetch failed: no route for ${url}`);
    return r[1](init);
  };
  return { fn, calls };
}
