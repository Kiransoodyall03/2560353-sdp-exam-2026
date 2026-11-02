// Default plugin behaviour, used as-is for LWM and OPG until their own plugins land (P5/P6), and as the
// base for RTA. Field names below come from the service specs.
import type { ServiceId, TopologyEntity } from '../../../shared/types.js';
import { parseMessage } from '../core/parse.js';
import type { StateStore } from '../core/state-store.js';
import type { TopologyRegistry } from '../core/topology.js';
import type { Kpi, Plugin, PlatformContext, StreamExpectation } from './types.js';

/** Liveness rule shared by all services: any of the entity's streams within 3 × its longest period. */
export function defaultExpectation(
  service: string,
  entity: TopologyEntity,
  topology: TopologyRegistry,
  state: StateStore,
): StreamExpectation | null {
  const streams = topology.streamsFor(service, entity);
  if (streams.length === 0) return null;
  if (state.value(service, entity.id, 'enabled') === false) return null; // disabled entities publish nothing
  let periodS = Math.max(...streams.map((s) => s.periodS ?? 0));
  const interval = state.value(service, entity.id, 'sample_interval_s'); // LWM per-site sample interval
  if (typeof interval === 'number' && interval > 0) periodS = interval;
  if (!(periodS > 0)) return null;
  return { streams: streams.map((s) => s.name), periodS };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function lwmKpis(state: StateStore): Kpi[] {
  const svc = state.service('lwm');
  let maxGust: number | null = null;
  const temps: number[] = [];
  for (const e of Object.values(svc.entities)) {
    const w = e.telemetry['weather']?.fields;
    if (!w) continue;
    const g = num(w['wind_gust_ms']);
    if (g !== null && (maxGust === null || g > maxGust)) maxGust = g;
    const t = num(w['temperature_k']);
    if (t !== null) temps.push(t);
  }
  const strikes = num(state.latest('lwm', 'global', 'lightning')?.fields['strikes_last_min']);
  return [
    { label: 'Active sites', value: num(state.value('lwm', 'global', 'active_sites')) },
    { label: 'Max gust', value: maxGust, unit: 'm/s', status: maxGust !== null && maxGust > 15 ? 'warn' : 'ok' },
    {
      label: 'Mean temp',
      value: temps.length ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length - 273.15) * 10) / 10 : null,
      unit: '°C',
    },
    { label: 'Strikes/min', value: strikes, status: strikes ? 'warn' : 'ok' },
  ];
}

function opgKpis(state: StateStore): Kpi[] {
  const g = state.latest('opg', 'global', 'power')?.fields ?? {};
  const b = state.latest('opg', 'batteries', 'power')?.fields ?? {};
  const d = state.latest('opg', 'diesel', 'power')?.fields ?? {};
  const kw = (v: unknown) => (num(v) === null ? null : Math.round(num(v)! / 100) / 10);
  const soc = num(b['state_of_charge_pct']);
  const reserve = num(state.value('opg', 'batteries', 'reserve_pct'));
  return [
    { label: 'Generation', value: kw(g['total_generation_w']), unit: 'kW' },
    { label: 'Load', value: kw(g['total_load_w']), unit: 'kW' },
    {
      label: 'SoC',
      value: soc === null ? null : Math.round(soc),
      unit: '%',
      status: soc === null ? undefined : reserve !== null && soc < reserve ? 'bad' : soc < 30 ? 'warn' : 'ok',
    },
    { label: 'Fuel', value: num(d['fuel_level_pct']) === null ? null : Math.round(num(d['fuel_level_pct'])!), unit: '%' },
    { label: 'Supply', value: typeof g['supply_mode'] === 'string' ? g['supply_mode'] : null },
  ];
}

export function createGenericPlugin(id: ServiceId): Plugin {
  let ctx: PlatformContext | null = null;
  return {
    id,
    commands: [],
    parse(topic, payload, recvTs, retained) {
      return [parseMessage(topic, payload, recvTs, retained)];
    },
    init(c) {
      ctx = c;
    },
    expectations(entity) {
      return ctx ? defaultExpectation(id, entity, ctx.topology, ctx.state) : null;
    },
    kpis() {
      if (!ctx) return [];
      if (id === 'lwm') return lwmKpis(ctx.state);
      if (id === 'opg') return opgKpis(ctx.state);
      return [];
    },
  };
}
