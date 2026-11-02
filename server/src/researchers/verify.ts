// Server-side researcher verification (rule 5). Every control, ack and resolve goes through here
// BEFORE anything is published or recorded. Failure attempts are rate limited per client.
import type { AlertService, VerifyFailReason } from '../../../shared/types.js';
import { ApiError, type ArlApiClient } from '../arl-api/client.js';

export interface VerifiedResearcher {
  code: string;
  name: string;
}
export type VerifyOutcome =
  | { ok: true; researcher: VerifiedResearcher; service: AlertService }
  | { ok: false; reason: VerifyFailReason; service: AlertService; retryAfterS?: number };

export const RESEARCHER_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const REASONS: Record<string, VerifyFailReason> = {
  unknown: 'unknown',
  defunct: 'defunct',
  not_permitted: 'not_permitted',
};

export class ResearcherVerifier {
  constructor(private readonly api: ArlApiClient) {}

  /**
   * Service alerts/controls: POST /v1/researchers/verify for that service.
   * Platform alerts: any active researcher (GET /v1/researchers/{code}).
   */
  async verify(code: string, service: AlertService): Promise<VerifyOutcome> {
    if (!RESEARCHER_CODE_RE.test(code)) return { ok: false, reason: 'invalid', service };
    try {
      if (service === 'platform') {
        const r = await this.api.researcher(code);
        if (!r) return { ok: false, reason: 'unknown', service };
        if (r.status !== 'active') return { ok: false, reason: 'defunct', service };
        return { ok: true, researcher: { code: r.code, name: r.name }, service };
      }
      const v = await this.api.verify(code, service);
      if (!v.valid) return { ok: false, reason: REASONS[v.reason ?? ''] ?? 'unknown', service };
      const r = await this.api.researcher(code);
      return { ok: true, researcher: { code, name: r?.name ?? code }, service };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'rate_limited') {
        return { ok: false, reason: 'rate_limited', service, retryAfterS: err.retryAfterS ?? 1 };
      }
      return { ok: false, reason: 'api_unavailable', service };
    }
  }
}

/** Sliding-window limiter for failed verifications, keyed by client address. */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(key: string): number | null {
    const list = this.prune(key);
    if (list.length < this.max) return null;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.prune(key);
    list.push(this.now());
    this.hits.set(key, list);
  }

  private prune(key: string): number[] {
    const t = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((x) => x > t);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }
}

export const VERIFY_MESSAGES: Record<VerifyFailReason, string> = {
  unknown: 'Unknown researcher code.',
  defunct: 'This researcher is no longer active.',
  not_permitted: 'This researcher is not permitted to work on this service.',
  api_unavailable: 'The ARL API is unreachable, so the researcher cannot be verified. Try again shortly.',
  rate_limited: 'The ARL API is rate limiting requests. Try again in a moment.',
  invalid: 'That is not a valid researcher code.',
};
