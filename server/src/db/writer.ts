// Bounded write queue. Every MQTT message becomes a raw row (rule 3); parsed messages are persisted by
// the generic + plugin persisters in the same transaction. Flush every 250 ms or at 500 rows.
// On overflow the queue keeps raw rows only and reports degraded=true.
import type { Parsed } from '../core/parse.js';
import type { Db } from './index.js';

export interface RawRow {
  simTs: number | null;
  recvTs: number;
  service: string;
  entity: string | null;
  kind: string;
  topic: string;
  payload: string;
  retained: boolean;
}

interface Item {
  raw: RawRow;
  parsed: Parsed[] | null;
}

export interface WriterOptions {
  capacity: number; // full items (raw + typed)
  hardCapacity: number; // raw-only items beyond capacity; past this, messages are dropped (counted)
  flushMs: number;
  flushRows: number;
  maxRowsPerTxn: number;
}

export const DEFAULT_WRITER: WriterOptions = {
  capacity: 50_000,
  hardCapacity: 200_000,
  flushMs: 250,
  flushRows: 500,
  maxRowsPerTxn: 5_000,
};

export type Persister = (batch: Parsed[], db: Db) => void;

export interface WriterStats {
  degraded: boolean;
  queueDepth: number;
  written: number;
  dropped: number;
  rawOnly: number;
  lastFlushMs: number | null;
  flushes: number;
  errors: number;
}

export class BatchWriter {
  private queue: Item[] = [];
  private timer: NodeJS.Timeout | null = null;
  private scheduled = false;
  private readonly opt: WriterOptions;
  private readonly insertRaw;
  readonly stats: WriterStats = {
    degraded: false,
    queueDepth: 0,
    written: 0,
    dropped: 0,
    rawOnly: 0,
    lastFlushMs: null,
    flushes: 0,
    errors: 0,
  };
  private degradedSince: number | null = null;
  onDegradedChange: ((degraded: boolean) => void) | null = null;
  onError: ((err: unknown) => void) | null = null;
  /** Called once after a batch commits successfully, with the batch's parsed messages (e.g. replay snapshots). */
  onFlush: ((batch: Parsed[]) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly persisters: Persister[],
    options: Partial<WriterOptions> = {},
  ) {
    this.opt = { ...DEFAULT_WRITER, ...options };
    this.insertRaw = db.prepare(
      `INSERT INTO raw_messages (sim_ts, recv_ts, service, entity, kind, topic, payload, retained)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.opt.flushMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.queue.length) this.flush();
  }

  enqueue(raw: RawRow, parsed: Parsed[] | null): void {
    const depth = this.queue.length;
    if (depth >= this.opt.hardCapacity) {
      this.stats.dropped++;
      this.setDegraded(true);
      return;
    }
    if (depth >= this.opt.capacity) {
      this.stats.rawOnly++;
      this.setDegraded(true);
      this.queue.push({ raw, parsed: null });
    } else {
      this.queue.push({ raw, parsed });
    }
    this.stats.queueDepth = this.queue.length;
    if (this.queue.length >= this.opt.flushRows && !this.scheduled) {
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        this.flush();
      });
    }
  }

  /** Writes up to maxRowsPerTxn queued items in one transaction. Returns rows written. */
  flush(): number {
    if (this.queue.length === 0) {
      this.maybeRecover();
      return 0;
    }
    const batch = this.queue.splice(0, this.opt.maxRowsPerTxn);
    const started = performance.now();
    const parsed: Parsed[] = [];
    let committed = false;
    try {
      this.db.transaction(() => {
        for (const { raw, parsed: p } of batch) {
          this.writeRaw(raw);
          if (p) for (const x of p) parsed.push(x);
        }
        for (const persist of this.persisters) persist(parsed, this.db);
      })();
      this.stats.written += batch.length;
      committed = true;
    } catch (err) {
      this.stats.errors++;
      this.onError?.(err);
      // a typed persister failed and rolled the batch back: keep the raw rows anyway (rule 3)
      try {
        this.db.transaction(() => {
          for (const { raw } of batch) this.writeRaw(raw);
        })();
        this.stats.written += batch.length;
        this.stats.rawOnly += batch.length;
      } catch (err2) {
        this.stats.dropped += batch.length;
        this.onError?.(err2);
      }
    }
    if (committed) {
      // one hook call after the batch is committed; kept out of the transaction's catch so a
      // subscriber error can never trigger the raw-only rewrite fallback above.
      try {
        this.onFlush?.(parsed);
      } catch (err) {
        this.onError?.(err);
      }
    }
    this.stats.flushes++;
    this.stats.lastFlushMs = Math.round((performance.now() - started) * 10) / 10;
    this.stats.queueDepth = this.queue.length;
    this.maybeRecover();
    return batch.length;
  }

  private writeRaw(raw: RawRow): void {
    this.insertRaw.run(raw.simTs, raw.recvTs, raw.service, raw.entity, raw.kind, raw.topic, raw.payload, raw.retained ? 1 : 0);
  }

  private maybeRecover() {
    if (this.stats.degraded && this.queue.length < this.opt.capacity / 10) {
      if (this.degradedSince !== null && Date.now() - this.degradedSince > 10_000) this.setDegraded(false);
    }
  }

  private setDegraded(d: boolean) {
    if (d === this.stats.degraded) {
      if (d) this.degradedSince = Date.now();
      return;
    }
    this.stats.degraded = d;
    this.degradedSince = d ? Date.now() : null;
    this.onDegradedChange?.(d);
  }
}

/** Generic persistence: telemetry (incl. backfill, flagged) and state history. */
export function genericPersister(): Persister {
  return (batch, db) => {
    if (batch.length === 0) return;
    const tel = db.prepare(
      `INSERT OR IGNORE INTO telemetry (service, entity, stream, sim_ts, json, backfill) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const st = db.prepare(
      `INSERT OR IGNORE INTO state_history (service, entity, item, sim_ts, value_json, removed) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const p of batch) {
      if (p.kind === 'telemetry') {
        tel.run(p.service, p.entity, p.stream, p.simTs, JSON.stringify(p.fields), p.backfill ? 1 : 0);
      } else if (p.kind === 'state' && p.simTs !== null) {
        st.run(p.service, p.entity, p.item, p.simTs, p.removed ? null : JSON.stringify(p.value), p.removed ? 1 : 0);
      }
    }
  };
}
