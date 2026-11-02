// In-memory 60 s sim-time buckets per (service, entity, metric). Flushed as deltas so late data
// (e.g. LWM backfill) merges into existing rows instead of overwriting them.
import type { Db } from './index.js';

export const BUCKET_MS = 60_000;

interface Delta {
  service: string;
  entity: string;
  metric: string;
  bucket: number;
  min: number;
  max: number;
  sum: number;
  count: number;
}

export class Aggregator {
  private deltas = new Map<string, Delta>();

  add(service: string, entity: string, metric: string, simTs: number, value: number): void {
    if (!Number.isFinite(value)) return;
    const bucket = Math.floor(simTs / BUCKET_MS) * BUCKET_MS;
    const key = `${service}|${entity}|${metric}|${bucket}`;
    const d = this.deltas.get(key);
    if (!d) {
      this.deltas.set(key, { service, entity, metric, bucket, min: value, max: value, sum: value, count: 1 });
      return;
    }
    if (value < d.min) d.min = value;
    if (value > d.max) d.max = value;
    d.sum += value;
    d.count++;
  }

  get pending(): number {
    return this.deltas.size;
  }

  /** Must run inside the writer transaction. */
  flush(db: Db): number {
    if (this.deltas.size === 0) return 0;
    const stmt = db.prepare(`
      INSERT INTO aggregates (service, entity, metric, bucket_ts, min, max, avg, count)
      VALUES (@service, @entity, @metric, @bucket, @min, @max, @avg, @count)
      ON CONFLICT (service, entity, metric, bucket_ts) DO UPDATE SET
        min = MIN(aggregates.min, excluded.min),
        max = MAX(aggregates.max, excluded.max),
        avg = (aggregates.avg * aggregates.count + excluded.avg * excluded.count) / (aggregates.count + excluded.count),
        count = aggregates.count + excluded.count`);
    const n = this.deltas.size;
    for (const d of this.deltas.values()) stmt.run({ ...d, avg: d.sum / d.count });
    this.deltas = new Map();
    return n;
  }
}
