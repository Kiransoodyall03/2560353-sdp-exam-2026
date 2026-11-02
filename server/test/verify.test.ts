import { describe, expect, it } from 'vitest';
import { ArlApiClient } from '../src/arl-api/client.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { maskCode } from '../src/log.js';
import { FailureLimiter, ResearcherVerifier } from '../src/researchers/verify.js';
import { json, mockFetch } from './helpers.js';

const BASE = 'http://api.test/v1';
const people: Record<string, { code: string; name: string; experiments: string[]; status: string }> = {
  'arl-as3': { code: 'arl-as3', name: 'Person A', experiments: ['rta', 'mhe', 'lwm', 'pes'], status: 'active' },
  'arl-old': { code: 'arl-old', name: 'Old Timer', experiments: ['rta'], status: 'defunct' },
};

/** Mimics /v1/researchers/verify and /v1/researchers/{code} from docs/openapi.json. */
function api(overrides: Parameters<typeof mockFetch>[0] = []) {
  return mockFetch([
    ...overrides,
    [
      '/researchers/verify',
      (init) => {
        const { code, service } = JSON.parse(String(init?.body)) as { code: string; service: string };
        const r = people[code];
        if (!r) return json(200, { valid: false, reason: 'unknown' });
        if (r.status !== 'active') return json(200, { valid: false, reason: 'defunct' });
        if (!r.experiments.includes(service)) return json(200, { valid: false, reason: 'not_permitted' });
        return json(200, { valid: true, reason: null });
      },
    ],
    [
      '/researchers/',
      () => json(404, { detail: 'not found' }),
    ],
  ]);
}

function researcherRoute(): [string, () => Response] {
  return ['/researchers/arl-', () => json(200, people['arl-as3'])];
}

describe('ResearcherVerifier', () => {
  it('accepts a researcher permitted for the service and returns the name', async () => {
    const m = api([researcherRoute()]);
    const v = new ResearcherVerifier(new ArlApiClient(BASE, { fetch: m.fn }));
    expect(await v.verify('arl-as3', 'rta')).toEqual({
      ok: true,
      researcher: { code: 'arl-as3', name: 'Person A' },
      service: 'rta',
    });
  });

  it('reports unknown, defunct and not permitted', async () => {
    const m = api();
    const v = new ResearcherVerifier(new ArlApiClient(BASE, { fetch: m.fn }));
    expect(await v.verify('zzz-000', 'rta')).toMatchObject({ ok: false, reason: 'unknown' });
    expect(await v.verify('arl-old', 'rta')).toMatchObject({ ok: false, reason: 'defunct' });
    expect(await v.verify('arl-as3', 'opg')).toMatchObject({ ok: false, reason: 'not_permitted' });
  });

  it('rejects malformed codes without calling the API', async () => {
    const m = api();
    const v = new ResearcherVerifier(new ArlApiClient(BASE, { fetch: m.fn }));
    expect(await v.verify('', 'rta')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await v.verify('a b; drop', 'rta')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(m.calls).toHaveLength(0);
  });

  it('verifies platform alerts against any active researcher', async () => {
    const m = mockFetch([
      ['/researchers/arl-as3', () => json(200, people['arl-as3'])],
      ['/researchers/arl-old', () => json(200, people['arl-old'])],
      ['/researchers/', () => json(404, {})],
    ]);
    const v = new ResearcherVerifier(new ArlApiClient(BASE, { fetch: m.fn }));
    expect(await v.verify('arl-as3', 'platform')).toMatchObject({ ok: true });
    expect(await v.verify('arl-old', 'platform')).toMatchObject({ ok: false, reason: 'defunct' });
    expect(await v.verify('nobody', 'platform')).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('caches verification results (60 s) to stay under the API rate limit', async () => {
    let now = 0;
    const m = api([researcherRoute()]);
    const client = new ArlApiClient(BASE, { fetch: m.fn, now: () => now });
    const v = new ResearcherVerifier(client);
    await v.verify('arl-as3', 'rta');
    await v.verify('arl-as3', 'rta');
    const verifyCalls = () => m.calls.filter((c) => c.url.endsWith('/researchers/verify')).length;
    expect(verifyCalls()).toBe(1);
    now = 61_000;
    await v.verify('arl-as3', 'rta');
    expect(verifyCalls()).toBe(2);
  });

  it('backs off on 429 using Retry-After and reports rate_limited', async () => {
    let now = 0;
    const m = mockFetch([['/researchers/verify', () => json(429, { detail: 'slow down' }, { 'retry-after': '7' })]]);
    const v = new ResearcherVerifier(new ArlApiClient(BASE, { fetch: m.fn, now: () => now }));
    expect(await v.verify('arl-as3', 'rta')).toEqual({ ok: false, reason: 'rate_limited', service: 'rta', retryAfterS: 7 });
    now = 3000;
    // still inside the back-off window: no new request is sent
    expect(await v.verify('arl-x', 'rta')).toMatchObject({ ok: false, reason: 'rate_limited', retryAfterS: 4 });
    expect(m.calls).toHaveLength(1);
  });

  it('reports api_unavailable when the API cannot be reached', async () => {
    const m = mockFetch([]);
    const v = new ResearcherVerifier(new ArlApiClient(BASE, { fetch: m.fn }));
    expect(await v.verify('arl-as3', 'rta')).toMatchObject({ ok: false, reason: 'api_unavailable' });
  });
});

describe('FailureLimiter', () => {
  it('blocks a client after too many failures within the window', () => {
    let now = 0;
    const l = new FailureLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(l.blocked('1.2.3.4')).toBeNull();
      l.fail('1.2.3.4');
    }
    expect(l.blocked('1.2.3.4')).toBe(60);
    expect(l.blocked('5.6.7.8')).toBeNull();
    now = 60_001;
    expect(l.blocked('1.2.3.4')).toBeNull();
  });
});

describe('config and logging', () => {
  const env = { MQTT_BROKER_ADDRESS: 'broker', MQTT_BROKER_PORT: '1883', ARL_API_ADDRESS: 'api', ARL_API_PORT: '8080' };

  it('builds every endpoint from the environment', () => {
    const c = loadConfig(env);
    expect(c.mqtt.url).toBe('mqtt://broker:1883');
    expect(c.api.baseUrl).toBe('http://api:8080/v1');
  });

  it('refuses to start without broker or API settings', () => {
    expect(() => loadConfig({ ...env, MQTT_BROKER_ADDRESS: '' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, ARL_API_PORT: 'eighty' })).toThrow(/ARL_API_PORT/);
  });

  it('never logs a researcher code in full', () => {
    expect(maskCode('arl-as3')).toBe('arl***');
    expect(maskCode('ab')).toBe('***');
  });
});
