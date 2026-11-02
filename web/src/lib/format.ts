// Display formatting. All times are shown in Africa/Johannesburg (spec: "Times and time zones").
export const TZ = 'Africa/Johannesburg';

const dateTime = new Intl.DateTimeFormat('en-ZA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const timeOnly = new Intl.DateTimeFormat('en-ZA', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function fmtTs(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  return dateTime.format(new Date(ts)).replace(',', '');
}

export function fmtTime(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  return timeOnly.format(new Date(ts));
}

/** "12 s", "4 min", "3.2 h", "2.1 d" */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.abs(ms) / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}

export function fmtAgo(ts: number | null | undefined, now: number | null | undefined): string {
  if (ts == null || now == null) return '—';
  return `${fmtDuration(now - ts)} ago`;
}

export function fmtNum(v: unknown, digits = 1): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v == null ? '—' : String(v);
  if (Math.abs(v) >= 1e6) return v.toExponential(2);
  return Number.isInteger(v) && digits <= 1 ? String(v) : v.toFixed(digits);
}

export function fmtValueUnit(v: number | null | undefined, unit: string | null | undefined, digits = 1): string {
  if (v == null) return '—';
  return unit ? `${fmtNum(v, digits)} ${unit}` : fmtNum(v, digits);
}

export const deg = (rad: number | null | undefined) => (rad == null ? null : (rad * 180) / Math.PI);
export const kToC = (k: number | null | undefined) => (k == null ? null : k - 273.15);

export function fmtAny(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return fmtNum(v, 2);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
