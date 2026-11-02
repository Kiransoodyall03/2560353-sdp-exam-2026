// Per-topic sequence tracking. Gaps = lost messages. LWM backfill re-publishes missing seqs later
// (original seq, backfill:true), so a gap can be filled after the fact.
const MAX_MISSING_PER_TOPIC = 5000;

interface TopicSeq {
  last: number;
  missing: Set<number>;
}

export interface GapResult {
  gap: number; // newly detected missing messages
  filled: number; // previously missing seqs that arrived now
  restart: boolean;
}

export class SeqTracker {
  private readonly topics = new Map<string, TopicSeq>();
  private readonly perService = new Map<string, { total: number; lastGapWallTs: number | null }>();

  constructor(private readonly wallNow: () => number = Date.now) {}

  observe(service: string, topic: string, seq: number | null, backfill: boolean): GapResult {
    const res: GapResult = { gap: 0, filled: 0, restart: false };
    if (seq === null) return res;
    const t = this.topics.get(topic);
    if (!t) {
      this.topics.set(topic, { last: seq, missing: new Set() });
      return res;
    }
    if (t.missing.delete(seq)) {
      res.filled = 1;
      return res;
    }
    if (backfill) return res; // old sample we never counted as missing (e.g. captured before we connected)
    if (seq > t.last + 1) {
      const gap = seq - t.last - 1;
      res.gap = gap;
      for (let s = t.last + 1; s < seq && t.missing.size < MAX_MISSING_PER_TOPIC; s++) t.missing.add(s);
      t.last = seq;
      const svc = this.svc(service);
      svc.total += gap;
      svc.lastGapWallTs = this.wallNow();
    } else if (seq === t.last + 1) {
      t.last = seq;
    } else if (seq < t.last) {
      // small step back = duplicate/reordering; back to 0 or a big step back = the service restarted
      if (seq === 0 || t.last - seq > 10) {
        res.restart = true;
        t.last = seq;
        t.missing.clear();
      }
    }
    return res;
  }

  private svc(service: string) {
    let s = this.perService.get(service);
    if (!s) this.perService.set(service, (s = { total: 0, lastGapWallTs: null }));
    return s;
  }

  stats(service: string): { total: number; outstanding: number; lastGapWallTs: number | null } {
    const s = this.perService.get(service) ?? { total: 0, lastGapWallTs: null };
    let outstanding = 0;
    const prefix = `arl/${service}/`;
    for (const [topic, t] of this.topics) if (topic.startsWith(prefix)) outstanding += t.missing.size;
    return { total: s.total, outstanding, lastGapWallTs: s.lastGapWallTs };
  }

  /** Topics with outstanding missing seqs, for alert metadata. */
  gapTopics(service: string, limit = 10): { topic: string; missing: number }[] {
    const prefix = `arl/${service}/`;
    const out: { topic: string; missing: number }[] = [];
    for (const [topic, t] of this.topics) if (topic.startsWith(prefix) && t.missing.size) out.push({ topic, missing: t.missing.size });
    return out.sort((a, b) => b.missing - a.missing).slice(0, limit);
  }
}
