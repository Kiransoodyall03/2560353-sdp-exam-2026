// Fills placeholder alerts ("raised before capture") with their original raise event from the ARL API
// backlog. The source is labelled in metadata.details_source; our own raw_messages stay the source of truth.
import type { AlertService } from '../../../shared/types.js';
import type { ArlApiClient } from '../arl-api/client.js';
import type { Logger } from '../log.js';
import type { AlertStore } from './store.js';
import { parseAlertPayload, type AlertWorkflow } from './workflow.js';

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const LOOKBACK_MS = 7 * 24 * 3600_000 - 60_000; // backlog serves at most 7 days per request

export class PlaceholderEnricher {
  private pending = new Set<AlertService>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly api: ArlApiClient,
    private readonly store: AlertStore,
    private readonly workflow: AlertWorkflow,
    private readonly simNow: (service: string) => number | null,
    private readonly log: Logger,
  ) {}

  /** Debounced: one backlog download per service at a time. */
  request(service: AlertService): void {
    if (service === 'platform') return;
    this.pending.add(service);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, 2000);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.size) {
        const service = this.pending.values().next().value as AlertService;
        this.pending.delete(service);
        await this.enrich(service);
      }
    } finally {
      this.running = false;
    }
  }

  async enrich(service: AlertService): Promise<number> {
    const want = new Set(this.store.openForService(service).filter((a) => a.placeholder).map((a) => a.alertId));
    if (!want.size) return 0;
    const to = (this.simNow(service) ?? Date.now()) + 1;
    let text: string;
    try {
      text = await this.api.backlogCsv(service, { kind: 'events', name: 'alert', from: to - LOOKBACK_MS, to });
    } catch (err) {
      this.log.warn({ service, err: err instanceof Error ? err.message : err }, 'backlog fetch for placeholders failed');
      return 0;
    }
    const rows = parseCsv(text);
    const header = rows.shift() ?? [];
    const col = header.indexOf('payload');
    if (col < 0) return 0;
    // latest raise per wanted id (escalations re-raise under the same id)
    const latest = new Map<string, ReturnType<typeof parseAlertPayload>>();
    for (const r of rows) {
      const raw = r[col];
      if (!raw) continue;
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        continue;
      }
      const p = parseAlertPayload(body);
      if (!p || p.state !== 'raised' || !want.has(p.alert_id)) continue;
      const prev = latest.get(p.alert_id);
      if (!prev || p.ts >= prev.ts) latest.set(p.alert_id, p);
    }
    let n = 0;
    for (const p of latest.values()) if (p && this.workflow.fillFromBacklog(service, p)) n++;
    if (n) this.log.info({ service, filled: n }, 'placeholder alerts filled from API backlog');
    return n;
  }
}
