// Shared researcher guard (rule 5): every control, ack, resolve and preset run verifies the header
// code server-side for that service BEFORE anything is published or recorded.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AlertService } from '../../../shared/types.js';
import type { Platform } from '../core/platform.js';
import { FailureLimiter, VERIFY_MESSAGES, type VerifiedResearcher } from '../researchers/verify.js';

export const RESEARCHER_HEADER = 'x-researcher-code';

export interface ResearcherGuard {
  /**
   * Returns the verified researcher, or null after having sent the error reply. `action` only shapes
   * the plain-language refusal, so a refused control reads "not permitted to control OPG" while a
   * refused acknowledgement reads "not permitted to operate OPG".
   */
  require(
    req: FastifyRequest,
    reply: FastifyReply,
    service: AlertService,
    action?: 'control' | 'operate',
  ): Promise<VerifiedResearcher | null>;
  /** Seconds to wait when the client is rate limited (null when not blocked). */
  blocked(req: FastifyRequest): number | null;
  fail(req: FastifyRequest): void;
}

/** One limiter for the whole app: failed attempts anywhere count against the client. */
export function researcherGuard(platform: Platform, max = 10, windowMs = 60_000): ResearcherGuard {
  const limiter = new FailureLimiter(max, windowMs);
  return {
    blocked: (req) => limiter.blocked(req.ip),
    fail: (req) => limiter.fail(req.ip),
    async require(req, reply, service, action = 'control') {
      const blocked = limiter.blocked(req.ip);
      if (blocked) {
        void reply
          .code(429)
          .header('retry-after', String(blocked))
          .send({ error: 'rate_limited', detail: 'Too many failed researcher verifications. Wait and try again.' });
        return null;
      }
      const raw = req.headers[RESEARCHER_HEADER];
      const code = typeof raw === 'string' ? raw.trim() : '';
      if (!code) {
        void reply.code(401).send({ error: 'researcher_required', detail: 'A researcher code is required.' });
        return null;
      }
      const v = await platform.verifier.verify(code, service);
      if (v.ok) return v.researcher;
      if (v.reason === 'api_unavailable' || v.reason === 'rate_limited') {
        const r = reply.code(503);
        if (v.retryAfterS) r.header('retry-after', String(v.retryAfterS));
        void r.send({ error: v.reason, detail: VERIFY_MESSAGES[v.reason] });
        return null;
      }
      limiter.fail(req.ip);
      const detail =
        v.reason === 'not_permitted'
          ? `This researcher is not permitted to ${action} ${service.toUpperCase()}.`
          : VERIFY_MESSAGES[v.reason];
      void reply.code(403).send({ error: `researcher_${v.reason}`, detail });
      return null;
    },
  };
}
