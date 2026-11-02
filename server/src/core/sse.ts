// Server-Sent Events hub. Channels coalesce keyed patches and appends and flush on a 250 ms tick (≤ 4 Hz).
// Dynamic channels (e.g. `scan:<scan_id>`) only do work while someone is subscribed.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SseEnvelope, SseType } from '../../../shared/types.js';

type SnapshotFn = (channel: string, query: Record<string, string>) => unknown;

interface Client {
  id: number;
  reply: FastifyReply;
  channel: string;
}

interface Pending {
  patch: Map<string, unknown>;
  append: unknown[];
}

export class SseHub {
  private clients = new Map<string, Set<Client>>();
  private snapshots = new Map<string, SnapshotFn>();
  private prefixSnapshots: [string, SnapshotFn][] = [];
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private tickTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly simNow: () => number | null,
    private readonly tickMs = 250,
  ) {}

  start(): void {
    this.tickTimer = setInterval(() => this.tick(), this.tickMs);
    this.pingTimer = setInterval(() => this.ping(), 15_000);
    this.tickTimer.unref?.();
    this.pingTimer.unref?.();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const set of this.clients.values()) for (const c of set) c.reply.raw.end();
    this.clients.clear();
  }

  register(channel: string, snapshot: SnapshotFn): void {
    this.snapshots.set(channel, snapshot);
  }

  registerPrefix(prefix: string, snapshot: SnapshotFn): void {
    this.prefixSnapshots.push([prefix, snapshot]);
  }

  knows(channel: string): boolean {
    return this.snapshots.has(channel) || this.prefixSnapshots.some(([p]) => channel.startsWith(p));
  }

  hasSubscribers(channel: string): boolean {
    return (this.clients.get(channel)?.size ?? 0) > 0;
  }

  subscriberCount(): number {
    let n = 0;
    for (const s of this.clients.values()) n += s.size;
    return n;
  }

  /** Coalesced keyed update; `null` means the key was removed. */
  patch(channel: string, key: string, value: unknown): void {
    if (!this.hasSubscribers(channel)) return;
    this.pendingFor(channel).patch.set(key, value);
  }

  append(channel: string, items: unknown[]): void {
    if (!this.hasSubscribers(channel) || items.length === 0) return;
    this.pendingFor(channel).append.push(...items);
  }

  handle(req: FastifyRequest, reply: FastifyReply, channel: string, query: Record<string, string>): void {
    const snap = this.snapshots.get(channel) ?? this.prefixSnapshots.find(([p]) => channel.startsWith(p))?.[1];
    reply.hijack();
    const origin = req.headers.origin;
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    };
    if (origin && reply.getHeader('access-control-allow-origin') === origin) {
      headers['access-control-allow-origin'] = origin;
      headers['vary'] = 'Origin';
    }
    reply.raw.writeHead(200, headers);
    reply.raw.write('retry: 2000\n\n');
    const client: Client = { id: this.nextId++, reply, channel };
    let set = this.clients.get(channel);
    if (!set) this.clients.set(channel, (set = new Set()));
    set.add(client);
    req.raw.on('close', () => {
      set!.delete(client);
      if (set!.size === 0) {
        this.clients.delete(channel);
        this.pending.delete(channel);
      }
    });
    if (snap) this.write(client, 'snapshot', snap(channel, query));
  }

  /** Sends a one-off message immediately (bypasses coalescing). */
  broadcast(channel: string, type: SseType, data: unknown): void {
    const set = this.clients.get(channel);
    if (!set) return;
    for (const c of set) this.write(c, type, data);
  }

  private pendingFor(channel: string): Pending {
    let p = this.pending.get(channel);
    if (!p) this.pending.set(channel, (p = { patch: new Map(), append: [] }));
    return p;
  }

  private tick(): void {
    for (const [channel, p] of this.pending) {
      const set = this.clients.get(channel);
      if (!set || set.size === 0) continue;
      if (p.patch.size) {
        const data = Object.fromEntries(p.patch);
        for (const c of set) this.write(c, 'patch', data);
      }
      if (p.append.length) {
        for (const c of set) this.write(c, 'append', p.append);
      }
    }
    this.pending.clear();
  }

  private ping(): void {
    for (const set of this.clients.values()) for (const c of set) c.reply.raw.write(': ping\n\n');
  }

  private write(c: Client, type: SseType, data: unknown): void {
    const env: SseEnvelope = { type, channel: c.channel, simTs: this.simNow(), data };
    try {
      c.reply.raw.write(`data: ${JSON.stringify(env)}\n\n`);
    } catch {
      /* client went away; cleaned up on close */
    }
  }
}
