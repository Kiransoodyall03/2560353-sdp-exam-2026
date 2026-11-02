// Runs a mutating request with a verified researcher code. If the server rejects the code (it re-verifies
// every action), the cached verification is dropped so the next attempt prompts again.
import { useCallback, useState } from 'react';
import type { AlertService } from '../../../shared/types';
import { ApiError, errorText } from './api';
import { useResearcher } from './researcher';

export interface ActionState {
  busy: boolean;
  error: string | null;
  clearError(): void;
}

export function useResearcherAction(): ActionState & {
  run<T>(services: AlertService[], purpose: string, fn: (code: string) => Promise<T>): Promise<T | null>;
} {
  const { require, invalidate } = useResearcher();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(services: AlertService[], purpose: string, fn: (code: string) => Promise<T>): Promise<T | null> => {
      setError(null);
      let code: string | null = null;
      for (const s of [...new Set(services)]) {
        code = await require(s, purpose);
        if (!code) return null; // cancelled
      }
      if (!code) return null;
      setBusy(true);
      try {
        return await fn(code);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403 && err.code.startsWith('researcher_')) {
          for (const s of services) invalidate(s);
        }
        setError(errorText(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [require, invalidate],
  );

  return { run, busy, error, clearError: () => setError(null) };
}
