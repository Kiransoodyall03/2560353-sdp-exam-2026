// Pure helpers for the replay timeline: the speed list, window presets, clamping, the playhead ↔ sim-time
// mapping and the sim-time ↔ datetime-local conversion. No React and no IO here, so every rule the bottom bar
// relies on is unit-tested in isolation (see replay-utils.test.ts). The DTO shapes mirror server/src/replay/types.ts
// — the web cannot import server files (they pull in node deps), so the few fields we read are re-declared here.

/** Playback speeds the engine accepts (mirrors server SPEEDS). The bar only offers the four the task names. */
export type Speed = 0.5 | 1 | 2 | 4 | 8 | 16 | 60;
export const ALL_SPEEDS: readonly Speed[] = [0.5, 1, 2, 4, 8, 16, 60];
/** The speed buttons on the bottom bar. */
export const SPEED_OPTIONS: readonly Speed[] = [1, 4, 16, 60];

export function isSpeed(v: number): v is Speed {
  return (ALL_SPEEDS as readonly number[]).includes(v);
}

/** "1×", "60×" — the multiplication sign the design system uses for playback rate. */
export function speedLabel(s: number): string {
  return `${s}×`;
}

export interface WindowPreset {
  label: string;
  ms: number;
}
/** Trailing windows offered on the bar; each is clamped to the stored range before use. */
export const WINDOW_PRESETS: readonly WindowPreset[] = [
  { label: 'Last 1 h', ms: 60 * 60_000 },
  { label: 'Last 3 h', ms: 3 * 60 * 60_000 },
  { label: 'Last 24 h', ms: 24 * 60 * 60_000 },
];
export const DEFAULT_WINDOW_MS = WINDOW_PRESETS[0]!.ms;

/** A jump of ±5 minutes on the bar. */
export const JUMP_MS = 5 * 60_000;

// Mirrors of the server replay DTOs (only the fields the UI reads).
export interface ReplayRange {
  min: number | null;
  max: number | null;
}
export interface ReplayRangeDTO {
  overall: ReplayRange;
  services: Record<string, ReplayRange>;
}
export type ReplayMarkerKind = 'alert' | 'command' | 'scan_start' | 'scan_end';
export interface ReplayMarker {
  ts: number;
  kind: ReplayMarkerKind;
  service: string;
  alertId?: string;
  action?: string;
  severity?: string;
  actor?: string | null;
  commandId?: string;
  control?: string;
  researcher?: string;
  outcome?: string;
  scanId?: string;
}
export interface ReplayMarkersDTO {
  from: number;
  to: number;
  markers: ReplayMarker[];
  truncated: boolean;
}

export interface Window {
  from: number;
  to: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * The visible window: the trailing `ms` ending at `anchor` (default the latest stored sim ts), clamped so it
 * never runs off either end of the stored range. Returns null when there is no data to replay yet.
 */
export function clampWindow(range: ReplayRangeDTO | null, ms: number, anchor?: number | null): Window | null {
  const min = range?.overall.min ?? null;
  const max = range?.overall.max ?? null;
  if (min == null || max == null || max < min) return null;
  const to = clamp(anchor ?? max, min, max);
  const from = clamp(to - ms, min, max);
  return { from, to };
}

/** Playhead position on the track as a 0..1 fraction of the window (degenerate window → 0). */
export function positionFrac(t: number, win: Window): number {
  const span = win.to - win.from;
  if (span <= 0) return 0;
  return clamp((t - win.from) / span, 0, 1);
}

/** Percentage string for CSS `left`, from a sim time within the window. */
export function positionPct(t: number, win: Window): string {
  return `${(positionFrac(t, win) * 100).toFixed(4)}%`;
}

/** The sim time at a 0..1 track fraction (a click or drag position), clamped to the window. */
export function tFromFrac(frac: number, win: Window): number {
  const span = win.to - win.from;
  if (span <= 0) return win.to;
  return win.from + clamp(frac, 0, 1) * span;
}

/** Move the cursor by a signed offset, clamped to the window (used by ±5 min and step-to-edge). */
export function jumpBy(t: number, deltaMs: number, win: Window): number {
  return clamp(t + deltaMs, win.from, win.to);
}

// Africa/Johannesburg is a fixed UTC+2 with no DST (see lib/format.ts), so the sim-time ↔ datetime-local
// conversion is a plain offset — no Intl round-trip, which would be ambiguous for an <input> value.
const JHB_OFFSET_MS = 2 * 60 * 60_000;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Epoch ms → a `datetime-local` value ("YYYY-MM-DDTHH:mm:ss") in Africa/Johannesburg wall time. */
export function simTimeToInputValue(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '';
  const d = new Date(ts + JHB_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/** A `datetime-local` value in Africa/Johannesburg wall time → epoch ms, or null if it does not parse. */
export function inputValueToSimTime(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  if (!Number.isFinite(asUtc)) return null;
  return asUtc - JHB_OFFSET_MS;
}

/**
 * Marker → tick geometry on the track. `left` is the CSS percentage; `severity`/`kind` pick the height and
 * colour class (STEP 3). Kept here so the drawing rules are pure and testable.
 */
export interface TickGeom {
  left: string;
  className: string;
}
export function markerTick(marker: ReplayMarker, win: Window): TickGeom {
  const left = positionPct(marker.ts, win);
  let className = 'arl-replay__tick';
  if (marker.kind === 'alert') {
    if (marker.severity === 'critical') className += ' arl-replay__tick--crit';
    else if (marker.severity === 'warning') className += ' arl-replay__tick--warn';
    else className += ' arl-replay__tick--info';
  } else if (marker.kind === 'command') {
    className += ' arl-replay__tick--cmd';
  } else {
    className += ' arl-replay__tick--scan';
  }
  return { left, className };
}

/** A scan drawn as a thin bar spanning its start→end, clamped to the window (an unfinished scan runs to the edge). */
export interface ScanBarGeom {
  scanId: string;
  left: string;
  width: string;
}

/**
 * Pair scan_start / scan_end markers into bars over the window. Only scans whose start falls in the window are
 * drawn; a missing end (still running, or ended after the window) clamps to the right edge. Kept pure so the
 * geometry is unit-testable and shared by the bottom-bar track (STEP 3) and the Replay page (STEP 4).
 */
export function scanBars(markers: ReplayMarker[], win: Window): ScanBarGeom[] {
  const span = win.to - win.from;
  if (span <= 0) return [];
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  for (const m of markers) {
    if (!m.scanId) continue;
    if (m.kind === 'scan_start') starts.set(m.scanId, m.ts);
    else if (m.kind === 'scan_end') ends.set(m.scanId, m.ts);
  }
  const out: ScanBarGeom[] = [];
  for (const [scanId, s] of starts) {
    const e = ends.get(scanId) ?? win.to;
    const from = clamp(Math.min(s, e), win.from, win.to);
    const to = clamp(Math.max(s, e), win.from, win.to);
    const left = ((from - win.from) / span) * 100;
    // A hairline minimum so a scan that starts and ends inside one pixel is still visible/clickable.
    const width = Math.max(((to - from) / span) * 100, 0.2);
    out.push({ scanId, left: `${left.toFixed(4)}%`, width: `${width.toFixed(4)}%` });
  }
  return out;
}

/**
 * One-line human description of a marker for a hover tooltip or an event-log row (the caller prefixes the
 * formatted sim time). Carries what the task asks to see: alert action/severity and who acked/resolved it,
 * command control/researcher/outcome, scan start/end.
 */
export function markerLabel(m: ReplayMarker): string {
  if (m.kind === 'alert') {
    const sev = m.severity ? ` [${m.severity}]` : '';
    const who = m.actor ? ` by ${m.actor}` : '';
    return `${m.service} alert ${m.action ?? ''}${sev}${who}`.trim();
  }
  if (m.kind === 'command') {
    const by = m.researcher ? ` by ${m.researcher}` : '';
    const out = m.outcome ? ` — ${m.outcome}` : '';
    return `${m.service} command ${m.control ?? ''}${by}${out}`.trim();
  }
  if (m.kind === 'scan_start') return `RTA scan ${m.scanId ?? ''} started`;
  return `RTA scan ${m.scanId ?? ''} ended`;
}
