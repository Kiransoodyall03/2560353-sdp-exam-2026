// Command contracts: a plugin describes each control once (zod schema + safeguards + how to render it)
// and the generic command service runs the same pipeline for every service:
//   zod → verify researcher (route) → guards → confirm token → insert → publish → ack tracker.
import type { z } from 'zod';
import type { CommandUi } from '../../../shared/commands.js';
import type { ServiceId } from '../../../shared/types.js';
import type { ArlApiClient } from '../arl-api/client.js';
import type { SimClock } from '../core/clock.js';
import type { SseHub } from '../core/sse.js';
import type { StateStore } from '../core/state-store.js';
import type { TopologyRegistry } from '../core/topology.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../log.js';

/** Everything a safeguard may look at. Structurally satisfied by the Platform. */
export interface CommandContext {
  db: Db;
  state: StateStore;
  topology: TopologyRegistry;
  api: ArlApiClient;
  log: Logger;
  sse: SseHub;
  clock: SimClock;
}

export interface GuardInput {
  service: ServiceId;
  entity: string;
  value: unknown;
  ctx: CommandContext;
}

/** A hard refusal (HTTP 409). `message` is the plain-language text the UI shows. */
export interface GuardBlock {
  code: string;
  message: string;
}

/** Facts the operator must confirm before the command is published (HTTP 428 + one-shot token). */
export interface ConfirmNeed {
  title: string;
  facts: string[];
}

export interface CommandSpec {
  control: string;
  entityKinds: string[];
  ui: CommandUi;
  /** Validates the `value` of the command (spec §3 value types). */
  schema: z.ZodTypeAny;
  guard?(input: GuardInput): GuardBlock | null;
  confirm?(input: GuardInput): ConfirmNeed | null;
}

export interface PresetStep {
  entity: string;
  control: string;
  value: unknown;
}

export interface PresetSpec {
  id: string;
  name: string;
  description: string;
  steps: PresetStep[];
}

export interface SubmitInput {
  service: ServiceId;
  entity: string;
  control: string;
  value: unknown;
  /** The researcher, already verified for the service by the route. */
  researcher: { code: string; name: string };
  confirmToken?: string | null;
  origin?: 'operator' | 'preset' | 'schedule';
  /** Presets/schedules were confirmed by the operator when they were created or clicked. */
  skipConfirm?: boolean;
}

export type SubmitResult =
  | { ok: true; commandId: string; state: string }
  | { ok: false; status: number; error: string; detail: string; facts?: string[]; token?: string; expiresAtTs?: number };

export type PublishFn = (topic: string, payload: string) => boolean;
