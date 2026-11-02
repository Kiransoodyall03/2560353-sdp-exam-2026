// Generic command service. One pipeline for every service:
//   zod (outer body) → verify researcher (route) → spec zod → safeguards → confirm token →
//   insert(commands) → publish arl/<svc>/cmd/<entity>/<control> → ack tracker.
// The plugin supplies the specs; nothing here knows about RTA or OPG specifics.
import { createHash, randomBytes } from 'node:crypto';
import { explainCommandReason, type PresetDTO } from '../../../shared/commands.js';
import type { CommandDTO, ServiceId } from '../../../shared/types.js';
import type { ParsedAck } from '../core/parse.js';
import { topics } from '../core/topics.js';
import {
  commandDTO,
  getCommandRow,
  insertCommand,
  listCommandRows,
  parseValue,
  presetDTOs,
  upsertPresets,
} from '../db/commands.js';
import { maskCode } from '../log.js';
import { AckTracker } from './acks.js';
import type {
  CommandContext,
  CommandSpec,
  PresetSpec,
  PresetStep,
  PublishFn,
  SubmitInput,
  SubmitResult,
} from './types.js';

export const CONFIRM_TTL_MS = 60_000;
const ENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `${entity}:${control}:${hash(value)}` — exactly what the UI echoes back on confirmation. */
export function confirmTokenOf(entity: string, control: string, value: unknown): string {
  const h = createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16);
  return `${entity}:${control}:${h}`;
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

const newCommandId = () => `cmd-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

export interface RegisteredPreset extends PresetSpec {
  service: ServiceId;
}

export class CommandService {
  private readonly specs = new Map<string, CommandSpec>();
  private readonly presets = new Map<string, RegisteredPreset>();
  private readonly confirmations = new Map<string, number>();
  private readonly descriptions = new Map<string, string>();
  readonly tracker: AckTracker;
  private publish: PublishFn | null = null;

  constructor(
    private readonly ctx: CommandContext,
    opts: { wallNow?: () => number } = {},
  ) {
    const wallNow = opts.wallNow ?? Date.now;
    this.tracker = new AckTracker({
      db: ctx.db,
      now: wallNow,
      simNow: () => ctx.clock.globalNow(),
      onChange: (c) => {
        ctx.sse.patch('commands', c.commandId, c);
      },
    });
    ctx.sse.register('commands', () => ({
      commands: listCommandRows(ctx.db, { limit: 200 }).map(commandDTO),
    }));
  }

  /** Registers a plugin's controls and presets (called once per plugin at start-up). */
  register(service: ServiceId, specs: CommandSpec[], presets: PresetSpec[] = []): void {
    for (const s of specs) this.specs.set(`${service}:${s.control}`, s);
    for (const p of presets) {
      this.presets.set(p.id, { ...p, service });
      this.descriptions.set(p.id, p.description);
    }
    if (presets.length) {
      upsertPresets(
        this.ctx.db,
        service,
        presets.map((p) => ({ id: p.id, name: p.name, steps: p.steps })),
      );
    }
  }

  setPublisher(fn: PublishFn | null): void {
    this.publish = fn;
  }

  specsFor(service: ServiceId) {
    const out: { service: ServiceId; control: string; entityKinds: string[]; ui: CommandSpec['ui'] }[] = [];
    for (const [key, s] of this.specs) {
      const [svc, control] = key.split(':') as [string, string];
      if (svc !== service) continue;
      out.push({ service, control, entityKinds: s.entityKinds, ui: s.ui });
    }
    return out.sort((a, b) => a.control.localeCompare(b.control));
  }

  presetsFor(service?: ServiceId): PresetDTO[] {
    return presetDTOs(this.ctx.db, service, (id) => this.descriptions.get(id) ?? '');
  }

  // ---------------------------------------------------------------- submit
  submit(input: SubmitInput): SubmitResult {
    const spec = this.specs.get(`${input.service}:${input.control}`);
    if (!spec) {
      return { ok: false, status: 400, error: 'unknown_control', detail: `${input.service} has no "${input.control}" control` };
    }
    if (!ENTITY_RE.test(input.entity)) {
      return { ok: false, status: 400, error: 'unknown_target', detail: 'Invalid entity id' };
    }
    const parsed = spec.schema.safeParse(input.value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
      return { ok: false, status: 400, error: 'invalid_value', detail: issues };
    }
    const value = parsed.data;

    const topo = this.ctx.topology.get(input.service);
    if (topo) {
      const entity = topo.entities.find((e) => e.id === input.entity);
      if (!entity) {
        return { ok: false, status: 400, error: 'unknown_target', detail: `No entity "${input.entity}" in ${input.service}` };
      }
      if (!spec.entityKinds.includes(entity.kind)) {
        return {
          ok: false,
          status: 400,
          error: 'unknown_target',
          detail: `"${input.entity}" is a ${entity.kind}; this control applies to ${spec.entityKinds.join(', ')}`,
        };
      }
    }

    const guardInput = { service: input.service, entity: input.entity, value, ctx: this.ctx };
    const blocked = spec.guard?.(guardInput) ?? null;
    if (blocked) return { ok: false, status: 409, error: blocked.code, detail: blocked.message };

    if (!input.skipConfirm && spec.confirm) {
      const need = spec.confirm(guardInput);
      if (need) {
        const token = confirmTokenOf(input.entity, input.control, value);
        this.pruneConfirmations();
        const until = this.confirmations.get(token) ?? 0;
        if (input.confirmToken !== token || until <= Date.now()) {
          // hand out a fresh one-shot token; the confirmation is recomputed on the retry
          this.confirmations.set(token, Date.now() + CONFIRM_TTL_MS);
          return {
            ok: false,
            status: 428,
            error: 'confirm_required',
            detail: need.title,
            facts: need.facts,
            token,
            expiresAtTs: Date.now() + CONFIRM_TTL_MS,
          };
        }
        this.confirmations.delete(token);
      }
    }

    const commandId = newCommandId();
    const requestedTs = this.ctx.clock.now(input.service) ?? Date.now();
    insertCommand(this.ctx.db, {
      commandId,
      service: input.service,
      entity: input.entity,
      control: input.control,
      value,
      researcher: input.researcher.code,
      researcherName: input.researcher.name,
      requestedTs,
      origin: input.origin ?? 'operator',
    });

    const published = this.publishCommand(input.service, input.entity, input.control, commandId, input.researcher.code, value);
    const row = getCommandRow(this.ctx.db, commandId);
    const dto = row ? commandDTO(row) : null;
    if (dto) this.ctx.sse.patch('commands', commandId, dto);
    if (!published) {
      return {
        ok: false,
        status: 503,
        error: 'broker_disconnected',
        detail: 'The MQTT broker is not connected, so the command was not sent',
      };
    }
    this.tracker.track(commandId);
    this.ctx.log.info(
      { commandId, service: input.service, entity: input.entity, control: input.control, by: maskCode(input.researcher.code) },
      'command published',
    );
    return { ok: true, commandId, state: 'pending' };
  }

  private publishCommand(
    service: ServiceId,
    entity: string,
    control: string,
    commandId: string,
    researcher: string,
    value: unknown,
  ): boolean {
    if (!this.publish) return false;
    const topic = topics.cmd(service, entity, control);
    try {
      return this.publish(topic, JSON.stringify({ command_id: commandId, researcher, value }));
    } catch (err) {
      this.ctx.log.warn({ err, topic }, 'publish failed');
      return false;
    }
  }

  // ------------------------------------------------------------------ acks
  /** Wired into the platform's ack dispatch. */
  onAck(ack: ParsedAck): CommandDTO | null {
    return this.tracker.ingest(ack);
  }

  // --------------------------------------------------------------- presets
  findPreset(presetId: string): RegisteredPreset | null {
    return this.presets.get(presetId) ?? this.presetFromDb(presetId);
  }

  async runPreset(presetId: string, researcher: SubmitInput['researcher'], origin: 'preset' | 'schedule' = 'preset') {
    const preset = this.findPreset(presetId);
    if (!preset) return { ok: false as const, error: 'unknown_preset', detail: `No preset "${presetId}"`, results: [] };
    const results = await this.runSteps(preset.service, preset.steps, researcher, origin);
    return { ok: results.failed.length === 0, results };
  }

  private presetFromDb(presetId: string): RegisteredPreset | null {
    const rows = this.ctx.db.prepare('SELECT * FROM presets WHERE id = ?').get(presetId) as
      | { id: string; service: string; name: string; steps_json: string }
      | undefined;
    if (!rows || !['rta', 'lwm', 'opg'].includes(rows.service)) return null;
    try {
      return {
        id: rows.id,
        service: rows.service as ServiceId,
        name: rows.name,
        description: this.descriptions.get(rows.id) ?? '',
        steps: JSON.parse(rows.steps_json) as PresetStep[],
      };
    } catch {
      return null;
    }
  }

  /** Runs a set of steps in order; safeguards are re-checked for every step. */
  async runSteps(
    service: ServiceId,
    steps: PresetStep[],
    researcher: SubmitInput['researcher'],
    origin: 'preset' | 'schedule',
  ) {
    const results: { entity: string; control: string; ok: boolean; commandId: string | null; error: string | null; detail: string | null }[] = [];
    for (const step of steps) {
      const r = this.submit({
        service,
        entity: step.entity,
        control: step.control,
        value: step.value,
        researcher,
        origin,
        skipConfirm: true,
      });
      if (r.ok) {
        results.push({ entity: step.entity, control: step.control, ok: true, commandId: r.commandId, error: null, detail: null });
      } else {
        results.push({
          entity: step.entity,
          control: step.control,
          ok: false,
          commandId: null,
          error: r.error,
          detail: explainCommandReason(r.error, { service, control: step.control }) ?? r.detail,
        });
      }
      if (!r.ok && (r.error === 'researcher_not_permitted' || r.error === 'api_unavailable')) break;
    }
    return { results, failed: results.filter((r) => !r.ok) };
  }

  history(query: { service?: ServiceId; entity?: string; limit?: number }): CommandDTO[] {
    // value is kept as-is in the DB; parseValue guards malformed rows
    return listCommandRows(this.ctx.db, query).map((r) => ({ ...commandDTO(r), value: parseValue(r.value_json) }));
  }

  get(commandId: string): CommandDTO | null {
    const row = getCommandRow(this.ctx.db, commandId);
    return row ? commandDTO(row) : null;
  }

  dispose(): void {
    this.tracker.dispose();
  }

  private pruneConfirmations(): void {
    const now = Date.now();
    for (const [k, v] of this.confirmations) if (v <= now) this.confirmations.delete(k);
  }
}
