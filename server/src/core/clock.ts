// Simulated-time clock per service. Envelope ts is authoritative; we estimate "sim now" between messages
// from the observed sim/wall rate (ARL_SPEEDUP), so silence can be judged in sim time.
interface ServiceClock {
  lastSim: number;
  lastWall: number;
  anchorSim: number;
  anchorWall: number;
  rate: number | null;
}

const MIN_RATE_WINDOW_MS = 5_000;
const REANCHOR_MS = 5 * 60_000;
const RESTART_JUMP_MS = 5 * 60_000;

export class SimClock {
  private readonly clocks = new Map<string, ServiceClock>();
  constructor(private readonly wallNow: () => number = Date.now) {}

  /** Feed a live (non-retained, non-backfill) message timestamp. */
  observe(service: string, simTs: number, wallTs: number = this.wallNow()): void {
    const c = this.clocks.get(service);
    if (!c) {
      this.clocks.set(service, { lastSim: simTs, lastWall: wallTs, anchorSim: simTs, anchorWall: wallTs, rate: null });
      return;
    }
    if (simTs < c.lastSim - RESTART_JUMP_MS) {
      // live messages are monotonic per service: a big backwards jump means the service restarted
      this.clocks.set(service, { lastSim: simTs, lastWall: wallTs, anchorSim: simTs, anchorWall: wallTs, rate: c.rate });
      return;
    }
    if (simTs >= c.lastSim) {
      c.lastSim = simTs;
      c.lastWall = wallTs;
    }
    const dw = c.lastWall - c.anchorWall;
    if (dw >= MIN_RATE_WINDOW_MS) {
      const r = (c.lastSim - c.anchorSim) / dw;
      if (r > 0.05 && r < 5000) c.rate = r;
      if (dw > REANCHOR_MS) {
        c.anchorSim = c.lastSim;
        c.anchorWall = c.lastWall;
      }
    }
  }

  now(service: string): number | null {
    const c = this.clocks.get(service);
    if (!c) return null;
    const elapsed = Math.max(0, this.wallNow() - c.lastWall);
    return Math.round(c.lastSim + elapsed * (c.rate ?? 1));
  }

  /** Latest sim time across services (the platform's notion of "now"). */
  globalNow(): number | null {
    let best: number | null = null;
    for (const s of this.clocks.keys()) {
      const n = this.now(s);
      if (n !== null && (best === null || n > best)) best = n;
    }
    return best;
  }

  rate(service: string): number | null {
    return this.clocks.get(service)?.rate ?? null;
  }

  lastWall(service: string): number | null {
    return this.clocks.get(service)?.lastWall ?? null;
  }

  lastSim(service: string): number | null {
    return this.clocks.get(service)?.lastSim ?? null;
  }
}
