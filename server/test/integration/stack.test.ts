// End-to-end checks against the live podman ARL stack, driven through OUR platform.
//
// The whole suite skips cleanly when the broker is unreachable (no stack running) — see probeStack() in
// support.ts. When the stack is up we boot our own server in-process (in-memory DB, ephemeral port) and
// exercise the real pipeline over HTTP: retained $topology, an operator command per service (verified via
// the ARL API, published on arl/<svc>/cmd/..., acked on arl/<svc>/ack/<command_id>) and the alerts that
// reach /api/alerts. Nothing here hard-codes a host, port or researcher code (exam rule 1): the broker and
// API come from .env and the code from TEST_RESEARCHER_CODE.
import type { TaskContext } from 'vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICES, type ServiceId } from '../../../shared/types.js';
import { bootPlatform, probeStack, waitFor, type TestStack } from './support.js';

const probe = await probeStack();
if (!probe.ok) console.warn(`[test:int] skipping the whole suite: ${probe.reason}`);

const researcherCode = (process.env.TEST_RESEARCHER_CODE ?? '').trim();
if (probe.ok && !researcherCode) {
  console.warn('[test:int] operator-command checks will skip: TEST_RESEARCHER_CODE is not set');
}

/** Command states the ack tracker treats as final (see server/src/commands/acks.ts). */
const TERMINAL = new Set(['completed', 'failed', 'rejected']);

/**
 * One safe command per service that our platform exposes operator controls for: no safeguard refuses it
 * and no confirmation is needed, so it publishes on the first submit. RTA `enable_dish = true` takes a dish
 * (kind "dish"); OPG `generation_priority = "solar_first"` applies to the service entity (kind "service").
 * LWM has no controls in our platform (it uses the generic plugin), so it is asserted to expose none.
 */
const SAFE_COMMAND: Partial<Record<ServiceId, { control: string; value: unknown; kind: string }>> = {
  rta: { control: 'enable_dish', value: true, kind: 'dish' },
  opg: { control: 'generation_priority', value: 'solar_first', kind: 'service' },
};

/** Marks the current test skipped (Vitest >= 1.0) after printing why; falls back to a plain return. */
function skip(ctx: TaskContext, message: string): void {
  console.warn(`[test:int] ${message}`);
  if (typeof ctx.skip === 'function') ctx.skip();
}

describe.skipIf(!probe.ok)('ARL stack, end to end through our platform', () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await bootPlatform(probe.cfg!);
    // the broker must be up before a command can be published
    const up = await waitFor(() => stack.platform.broker.connected, 15_000);
    if (!up) throw new Error('our platform did not connect to the MQTT broker within 15 s');
    // retained $topology for every service, read back through our own API
    for (const svc of SERVICES) {
      const topo = await waitFor(async () => {
        const r = await stack.app.inject({ method: 'GET', url: `/api/topology/${svc}` });
        return r.statusCode === 200 ? (r.json() as { entities: unknown[] }) : null;
      }, 20_000);
      if (!topo) throw new Error(`no retained $topology for ${svc} within 20 s`);
    }
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
  });

  it('serves retained $topology for rta, lwm and opg', async () => {
    for (const svc of SERVICES) {
      const r = await stack.app.inject({ method: 'GET', url: `/api/topology/${svc}` });
      expect(r.statusCode, `${svc} $topology`).toBe(200);
      const topo = r.json() as { service: string; version: string; entities: { id: string; kind: string }[] };
      expect(topo.service).toBe(svc);
      expect(topo.version).toBeTruthy();
      expect(topo.entities.length, `${svc} entities`).toBeGreaterThan(0);
    }
  });

  describe.skipIf(!researcherCode)('operator commands reach completed', () => {
    for (const svc of SERVICES) {
      it(`${svc}: a safe command is accepted and the ack reaches completed`, async (ctx) => {
        const spec = SAFE_COMMAND[svc];
        if (!spec) {
          // LWM: our platform exposes no operator controls for it (generic plugin), so there is nothing
          // to publish. Assert that rather than skipping, so the service is still covered.
          const r = await stack.app.inject({ method: 'GET', url: `/api/commands/specs/${svc}` });
          expect(r.statusCode).toBe(200);
          expect((r.json() as { controls: unknown[] }).controls).toEqual([]);
          console.warn(`[test:int] ${svc}: our platform exposes no operator controls, nothing to publish`);
          return;
        }

        // pick a live entity of the right kind from the retained topology (no hard-coded ids)
        const topo = (await stack.app.inject({ method: 'GET', url: `/api/topology/${svc}` })).json() as {
          entities: { id: string; kind: string }[];
        };
        const entity = topo.entities.find((e) => e.kind === spec.kind)?.id;
        if (!entity) {
          skip(ctx, `${svc}: no "${spec.kind}" entity in the live topology to command`);
          return;
        }

        const submit = await stack.app.inject({
          method: 'POST',
          url: '/api/commands',
          headers: { 'content-type': 'application/json', 'x-researcher-code': researcherCode },
          payload: { service: svc, entity, control: spec.control, value: spec.value },
        });

        // a code that is not permitted for this service is a provisioning detail, not a platform failure
        if (submit.statusCode === 403 && (submit.json() as { error?: string }).error === 'researcher_not_permitted') {
          skip(ctx, `${svc}: TEST_RESEARCHER_CODE is not permitted to control ${svc}`);
          return;
        }
        expect(submit.statusCode, `submit ${svc} ${spec.control}: ${submit.body}`).toBe(202);
        const commandId = (submit.json() as { command: { commandId: string } }).command.commandId;
        expect(commandId).toBeTruthy();

        // the service acks on arl/<svc>/ack/<command_id>; poll our API until the command is final
        const final = await waitFor(async () => {
          const r = await stack.app.inject({ method: 'GET', url: `/api/commands/${commandId}` });
          if (r.statusCode !== 200) return null;
          const c = r.json() as { state: string; reason: string | null; detail: string | null };
          return TERMINAL.has(c.state) ? c : null;
        }, 40_000);

        expect(final, `${svc} command ${commandId} reached a terminal state`).not.toBeNull();
        expect(final!.state, `${svc} command ended ${final!.state}: ${final!.reason ?? ''} ${final!.detail ?? ''}`).toBe(
          'completed',
        );
      });
    }
  });

  it('at least one alert per service arrives and appears in /api/alerts', async (ctx) => {
    const seen = new Map<string, { key: string; type: string }>();
    const all = await waitFor(async () => {
      const r = await stack.app.inject({ method: 'GET', url: '/api/alerts?includeResolved=1' });
      if (r.statusCode !== 200) return null;
      const alerts = (r.json() as { alerts: { key: string; service: string; type: string }[] }).alerts;
      for (const svc of SERVICES) {
        const a = alerts.find((x) => x.service === svc);
        if (a && !seen.has(svc)) seen.set(svc, { key: a.key, type: a.type });
      }
      return SERVICES.every((s) => seen.has(s)) ? alerts : null;
    }, 60_000, 500);

    if (!all) {
      // Only rta keeps alerts while idle; lwm and opg need an incident. Skip (do not fail) an idle stack.
      skip(
        ctx,
        `alerts seen for [${[...seen.keys()].join(', ') || 'none'}] only — load a scenario so every service ` +
          'raises one, e.g. ARL_SPEEDUP=10 ARL_SCENARIO=/scenarios/exam-test.toml',
      );
      return;
    }
    for (const svc of SERVICES) {
      const a = seen.get(svc);
      expect(a, `${svc} alert in /api/alerts`).toBeTruthy();
      expect(a!.key).toContain(svc);
      expect(a!.type).toBeTruthy();
    }
  });
});
