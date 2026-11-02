// Thin fetch wrapper for the platform API (same origin; Vite proxies /api in dev).
export const RESEARCHER_HEADER = 'x-researcher-code';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly retryAfterS: number | null = null,
    /** Parsed response body, for the 428 confirm_required facts and token. */
    readonly body: unknown = null,
  ) {
    super(detail || code);
  }
}

interface Opts {
  researcher?: string | null;
  signal?: AbortSignal;
}

async function request<T>(method: 'GET' | 'POST', path: string, body: unknown, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.researcher) headers[RESEARCHER_HEADER] = opts.researcher;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Platform server unreachable');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; detail?: string; message?: string };
    const ra = Number(res.headers.get('retry-after'));
    throw new ApiError(res.status, j.error ?? `http_${res.status}`, j.detail ?? j.message ?? res.statusText, ra > 0 ? ra : null, json);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, opts?: Opts) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body: unknown, opts?: Opts) => request<T>('POST', path, body, opts),
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.detail || err.code;
  if (err instanceof Error) return err.message;
  return String(err);
}
