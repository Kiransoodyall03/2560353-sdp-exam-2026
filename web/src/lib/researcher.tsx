// Researcher identity for the session. The code lives in memory only (never localStorage), is verified
// server-side per service via POST /api/verify, and every mutating request re-verifies it on the server.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AlertService, VerifyFailReason, VerifyResponse } from '../../../shared/types';
import { api, errorText, RESEARCHER_HEADER } from './api';

export const VERIFY_TEXT: Record<VerifyFailReason, string> = {
  unknown: 'No researcher has this code.',
  defunct: 'This researcher account is no longer active.',
  not_permitted: 'This researcher is not permitted on this experiment.',
  api_unavailable: 'The ARL API is unreachable, so the code cannot be checked right now. Try again shortly.',
  rate_limited: 'The ARL API is rate limiting verification. Wait a moment and try again.',
  invalid: 'Enter the researcher code (letters, digits and dashes).',
};

const SERVICE_LABEL: Record<AlertService, string> = {
  rta: 'Radio Telescope Array',
  lwm: 'Local Weather Monitoring',
  opg: 'Outpost Power Grid',
  platform: 'platform alerts',
};

/** Codes that depend on the service name the service: "this experiment" leaves the operator guessing. */
function reasonText(reason: VerifyFailReason, service: AlertService): string {
  if (reason === 'not_permitted') return `This researcher is not permitted on the ${SERVICE_LABEL[service]}.`;
  return VERIFY_TEXT[reason];
}

interface Prompt {
  service: AlertService;
  purpose: string;
  error: string | null;
  resolve: (code: string | null) => void;
}

interface ResearcherCtx {
  code: string | null;
  name: string | null;
  /** Services this code has been verified for in this session. */
  verified: ReadonlySet<AlertService>;
  /** Resolves a code verified for `service`, prompting if needed; null if the user cancels. */
  require(service: AlertService, purpose: string): Promise<string | null>;
  /** Call when the server rejected the code (403 researcher_*); the next require() re-prompts. */
  invalidate(service: AlertService): void;
  signOut(): void;
}

const Ctx = createContext<ResearcherCtx | null>(null);

export function useResearcher(): ResearcherCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useResearcher outside ResearcherProvider');
  return c;
}

async function verify(code: string, service: AlertService): Promise<VerifyResponse> {
  return api.post<VerifyResponse>('/api/verify', { service }, { researcher: code });
}

export function ResearcherProvider({ children }: { children: ReactNode }) {
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [verified, setVerified] = useState<Set<AlertService>>(new Set());
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const codeRef = useRef<string | null>(null);
  const verifiedRef = useRef(verified);
  verifiedRef.current = verified;

  const accept = useCallback((c: string, n: string | null, service: AlertService) => {
    codeRef.current = c;
    setCode(c);
    setName(n);
    setVerified((prev) => new Set(prev).add(service));
  }, []);

  const require = useCallback(
    async (service: AlertService, purpose: string): Promise<string | null> => {
      const current = codeRef.current;
      if (current && verifiedRef.current.has(service)) return current;
      let error: string | null = null;
      if (current) {
        try {
          const v = await verify(current, service);
          if (v.valid) {
            accept(current, v.name, service);
            return current;
          }
          error = v.reason ? reasonText(v.reason, service) : 'Verification failed.';
        } catch (err) {
          error = errorText(err);
        }
      }
      return new Promise((resolve) => setPrompt({ service, purpose, error, resolve }));
    },
    [accept],
  );

  const invalidate = useCallback((service: AlertService) => {
    setVerified((prev) => {
      const next = new Set(prev);
      next.delete(service);
      return next;
    });
  }, []);

  const signOut = useCallback(() => {
    codeRef.current = null;
    setCode(null);
    setName(null);
    setVerified(new Set());
  }, []);

  const value = useMemo(
    () => ({ code, name, verified, require, invalidate, signOut }),
    [code, name, verified, require, invalidate, signOut],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {prompt && (
        <CodePrompt
          prompt={prompt}
          initial={code ?? ''}
          onDone={(c, n) => {
            if (c) accept(c, n, prompt.service);
            prompt.resolve(c);
            setPrompt(null);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

function CodePrompt({
  prompt,
  initial,
  onDone,
}: {
  prompt: Prompt;
  initial: string;
  onDone: (code: string | null, name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(prompt.error);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const c = value.trim();
    if (!/^[A-Za-z0-9-]{3,64}$/.test(c)) {
      setError(VERIFY_TEXT.invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const v = await verify(c, prompt.service);
      if (v.valid) onDone(c, v.name);
      else setError(v.reason ? reasonText(v.reason, prompt.service) : 'Verification failed.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-scrim" role="presentation" onKeyDown={(e) => e.key === 'Escape' && onDone(null, null)}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="rc-title" onSubmit={submit}>
        <h2 id="rc-title">Researcher code required</h2>
        <p className="muted">
          {prompt.purpose} on <strong>{SERVICE_LABEL[prompt.service]}</strong>. The code is checked with the ARL API and
          recorded against the action. It is kept in this tab only.
        </p>
        <label className="field">
          <span>Researcher code</span>
          <input
            autoFocus
            name="researcher-code"
            autoComplete="off"
            spellCheck={false}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={error ? 'rc-error' : undefined}
          />
        </label>
        {error && (
          <p id="rc-error" className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <button type="button" className="arl-btn" onClick={() => onDone(null, null)} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="arl-btn arl-btn--primary" disabled={busy}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
        </div>
      </form>
    </div>
  );
}

export { RESEARCHER_HEADER };
