// Typed RTA parsing (spec §2): normal/scan telemetry, state items, scan lifecycle events. Pure.
import { z } from 'zod';
import { parseMessage, type Parsed } from '../../core/parse.js';

const n = z.number().finite().nullable().optional();

export const NormalFields = z
  .object({
    temperature_k: n,
    elevation_rad: n,
    azimuth_rad: n,
    power_w: n,
    system_temperature_k: n,
    fault_code: z.string().nullable().optional(),
    status: z.boolean().nullable().optional(),
  })
  .passthrough();
export type NormalFields = z.infer<typeof NormalFields>;

export const ScanFields = NormalFields.extend({
  scan_id: z.string().nullable().optional(),
  pointing_offset_ra_rad: n,
  pointing_offset_dec_rad: n,
  signal_strength: n,
  snr_db: n,
  band_hz: n,
  scan_progress: n,
});
export type ScanFields = z.infer<typeof ScanFields>;

const CustomTarget = z.object({ ra_rad: z.number(), dec_rad: z.number(), fov_rad: z.number() });
export const TargetValue = z.union([z.string(), CustomTarget]).nullable();

export const SCAN_EVENTS = ['started', 'paused', 'resumed', 'completed', 'cancelled', 'failed'] as const;
export const ScanEvent = z
  .object({
    scan_id: z.string().min(1),
    event: z.string().min(1),
    entity: z.string().optional(),
    reason: z.string().nullable().optional(),
    target: TargetValue.optional(),
    ra_rad: n,
    dec_rad: n,
    fov_rad: n,
    band_hz: n,
    grid_size: z.number().int().positive().max(1024).nullable().optional(),
    overlap: z.number().int().positive().max(10).nullable().optional(),
    dishes: z.array(z.string()).nullable().optional(),
    expected_duration_s: n,
    origin: z.string().nullable().optional(),
  })
  .passthrough();
export type ScanEvent = z.infer<typeof ScanEvent>;

const STATE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  commanded: z.object({ azimuth_rad: z.number(), elevation_rad: z.number() }).nullable(),
  subarray: z.string().nullable(),
  last_calibration: z.number().nullable(),
  enabled: z.boolean().nullable(),
  stowed: z.boolean().nullable(),
  members: z.array(z.string()).nullable(),
  scan_state: z.string().nullable(),
  target: TargetValue,
  observation_frequency: z.number().nullable(),
  next_scan: z.number().nullable(),
  scan_id: z.string().nullable(),
  active_dishes: z.number().int().nullable(),
  wind_stow: z.boolean().nullable(),
  online: z.boolean().nullable(),
  active_alerts: z.array(z.string()).nullable(),
};

/** Generic envelope parse + RTA field validation. Invalid fields become kind 'invalid' (raw row still kept). */
export function parseRta(topic: string, payload: Buffer | string, recvTs: number, retained = false): Parsed[] {
  const p = parseMessage(topic, payload, recvTs, retained);
  if (p.kind === 'telemetry') {
    const schema = p.stream === 'scan' ? ScanFields : p.stream === 'normal' ? NormalFields : null;
    if (schema) {
      const r = schema.safeParse(p.fields);
      if (!r.success) return [{ ...p, kind: 'invalid', reason: `bad_${p.stream}_fields` }];
      return [{ ...p, fields: r.data as Record<string, unknown> }];
    }
  }
  if (p.kind === 'state' && !p.removed) {
    const schema = STATE_SCHEMAS[p.item];
    if (schema) {
      const r = schema.safeParse(p.value);
      if (!r.success) return [{ ...p, kind: 'invalid', reason: `bad_state_${p.item}` }];
      return [{ ...p, value: r.data }];
    }
  }
  if (p.kind === 'event' && p.event === 'scan') {
    const r = ScanEvent.safeParse(p.body);
    if (!r.success) return [{ ...p, kind: 'invalid', entity: p.entity, reason: 'bad_scan_event' }];
    return [{ ...p, body: r.data as Record<string, unknown> }];
  }
  return [p];
}

/** A scan-stream sample that can be placed on the image (offsets and signal all present). */
export interface ScanSample {
  scanId: string;
  dish: string;
  ts: number;
  dra: number;
  ddec: number;
  signal: number;
  snr: number | null;
  bandHz: number | null;
  fault: string | null;
}

export function toScanSample(dish: string, ts: number, f: ScanFields): ScanSample | null {
  if (
    !f.scan_id ||
    f.pointing_offset_ra_rad == null ||
    f.pointing_offset_dec_rad == null ||
    f.signal_strength == null
  ) {
    return null;
  }
  return {
    scanId: f.scan_id,
    dish,
    ts,
    dra: f.pointing_offset_ra_rad,
    ddec: f.pointing_offset_dec_rad,
    signal: f.signal_strength,
    snr: f.snr_db ?? null,
    bandHz: f.band_hz ?? null,
    fault: f.fault_code ?? null,
  };
}
