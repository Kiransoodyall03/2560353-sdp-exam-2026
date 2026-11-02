// ARL API client. Read-only; rate limited on live (20 req/s, 429 + Retry-After). Caches: verify 60 s,
// researchers 60 s, targets and alert limits 5 min. Base URL comes from config only.
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly code: 'unreachable' | 'rate_limited' | 'not_found' | 'bad_response' | 'http_error',
    message: string,
    readonly status: number | null = null,
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
  }
}

const Researcher = z.object({
  code: z.string(),
  name: z.string(),
  experiments: z.array(z.string()),
  status: z.string(),
});
export type Researcher = z.infer<typeof Researcher>;

const VerifyResult = z.object({ valid: z.boolean(), reason: z.string().nullable().optional() });
export type VerifyResult = z.infer<typeof VerifyResult>;

const Target = z.object({
  id: z.string(),
  name: z.string(),
  ra_rad: z.number(),
  dec_rad: z.number(),
  fov_rad: z.number(),
  category: z.string().optional(),
});
export type Target = z.infer<typeof Target>;

const AlertLimit = z.object({ key: z.string(), value: z.number(), unit: z.string().nullable().optional() });
export type AlertLimit = z.infer<typeof AlertLimit>;

const Health = z.object({ status: z.string(), database: z.boolean().optional(), broker: z.boolean().nullable().optional() });
export type ApiHealth = z.infer<typeof Health>;

interface CacheEntry<T> {
  value: T;
  expires: number;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  timeoutMs?: number;
  verifyTtlMs?: number;
  catalogueTtlMs?: number;
  now?: () => number;
  fetch?: FetchFn;
}

export class ArlApiClient {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private blockedUntil = 0;
  private readonly timeoutMs: number;
  private readonly verifyTtlMs: number;
  private readonly catalogueTtlMs: number;
  private readonly now: () => number;
  private readonly fetchFn: FetchFn;
  lastError: string | null = null;
  lastOkWallTs: number | null = null;

  constructor(
    private readonly baseUrl: string,
    opts: ApiClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.verifyTtlMs = opts.verifyTtlMs ?? 60_000;
    this.catalogueTtlMs = opts.catalogueTtlMs ?? 300_000;
    this.now = opts.now ?? Date.now;
    this.fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  /** Root of the API (for /healthz, which lives outside /v1). */
  private get root(): string {
    return this.baseUrl.replace(/\/v1\/?$/, '');
  }

  async verify(code: string, service: string): Promise<VerifyResult> {
    return this.cached(`verify|${service}|${code}`, this.verifyTtlMs, async () =>
      VerifyResult.parse(
        await this.request(`${this.baseUrl}/researchers/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, service }),
        }),
      ),
    );
  }

  /** null when the code is unknown (404). */
  async researcher(code: string): Promise<Researcher | null> {
    return this.cached(`researcher|${code}`, this.verifyTtlMs, async () => {
      try {
        return Researcher.parse(await this.request(`${this.baseUrl}/researchers/${encodeURIComponent(code)}`));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not_found') return null;
        throw err;
      }
    });
  }

  async targets(): Promise<Target[]> {
    return this.cached('targets', this.catalogueTtlMs, async () =>
      z.array(Target).parse(await this.request(`${this.baseUrl}/targets`)),
    );
  }

  async alertLimits(service: string): Promise<AlertLimit[]> {
    return this.cached(`limits|${service}`, this.catalogueTtlMs, async () =>
      z.array(AlertLimit).parse(await this.request(`${this.baseUrl}/alert-limits/${encodeURIComponent(service)}`)),
    );
  }

  /** Last cached value without any network call (for synchronous safeguards/derivations). */
  peek<T>(key: 'targets' | `limits|${string}`): T | null {
    return (this.cache.get(key)?.value as T | undefined) ?? null;
  }

  async health(): Promise<ApiHealth> {
    return Health.parse(await this.request(`${this.root}/healthz`, {}, true));
  }

  /** GET /v1/backlog/{service}.csv (one download at a time per client on live). */
  async backlogCsv(
    service: string,
    q: { kind: 'telemetry' | 'state' | 'events'; name: string; from: number; to: number; entity?: string },
  ): Promise<string> {
    const key = q.kind === 'telemetry' ? 'stream' : q.kind === 'state' ? 'item' : 'event';
    const params = new URLSearchParams({ kind: q.kind, [key]: q.name, from: String(q.from), to: String(q.to) });
    if (q.entity) params.set('entity', q.entity);
    const text = await this.request(`${this.baseUrl}/backlog/${encodeURIComponent(service)}.csv?${params}`, {}, false, 'text');
    return text as string;
  }

  private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value as T;
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = load()
      .then((value) => {
        this.cache.set(key, { value, expires: this.now() + ttl });
        return value;
      })
      .catch((err: unknown) => {
        // serve stale catalogue data rather than failing when the API blips
        if (hit && !key.startsWith('verify|') && !key.startsWith('researcher|')) return hit.value as T;
        throw err;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async request(
    url: string,
    init: RequestInit = {},
    ignoreBlock = false,
    as: 'json' | 'text' = 'json',
  ): Promise<unknown> {
    const now = this.now();
    if (!ignoreBlock && now < this.blockedUntil) {
      throw new ApiError('rate_limited', 'ARL API rate limit, backing off', 429, Math.ceil((this.blockedUntil - now) / 1000));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw new ApiError('unreachable', `ARL API unreachable: ${this.lastError}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      const retryAfterS = Number.isFinite(ra) && ra > 0 ? ra : 1;
      this.blockedUntil = this.now() + retryAfterS * 1000;
      this.lastError = 'rate_limited';
      throw new ApiError('rate_limited', 'ARL API rate limited', 429, retryAfterS);
    }
    if (res.status === 404) throw new ApiError('not_found', 'not found', 404);
    if (as === 'text') {
      if (!res.ok) throw new ApiError('http_error', `ARL API HTTP ${res.status}`, res.status);
      const text = await res.text();
      this.lastError = null;
      this.lastOkWallTs = this.now();
      return text;
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      throw new ApiError('bad_response', `ARL API returned non-JSON (${res.status})`, res.status);
    }
    if (!res.ok) throw new ApiError('http_error', `ARL API HTTP ${res.status}`, res.status);
    this.lastError = null;
    this.lastOkWallTs = this.now();
    return body;
  }
}
