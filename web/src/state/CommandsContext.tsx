// App-wide command state: the control specs and presets a service exposes, the live command history,
// and send()/runPreset() which always go through the server pipeline.
//
// The history loads once with a plain GET; the `commands` SSE stream is only subscribed while a command
// is in flight, so an idle control room page keeps the same number of open streams as before controls.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CommandConfirmDTO, CommandSpecDTO, PresetDTO } from '../../../shared/commands';
import type { CommandDTO, ServiceId } from '../../../shared/types';
import { ApiError, api, errorText } from '../lib/api';
import { useResearcher } from '../lib/researcher';
import { mergePatch, useSse, type SseStatus } from '../lib/sse';

export interface SendInput {
  service: ServiceId;
  entity: string;
  control: string;
  value: unknown;
}

export interface SendOutcome {
  ok: boolean;
  /** Set when the command was published (watch it in `history`). */
  commandId?: string;
  /** Plain-language refusal (guard, verification, transport). */
  error?: string;
  /** Set on 428: the operator must confirm and resend with `confirm.token`. */
  confirm?: CommandConfirmDTO;
}

export interface PresetRunResult {
  entity: string;
  control: string;
  ok: boolean;
  commandId: string | null;
  error: string | null;
  detail: string | null;
}

interface CommandsCtx {
  status: SseStatus;
  history: Record<string, CommandDTO>;
  specs(service: ServiceId): CommandSpecDTO[];
  presets(service: ServiceId): PresetDTO[];
  /** Fetches a service's specs + presets once; safe to call on every render of a control panel. */
  ensure(service: ServiceId): void;
  specsLoading(service: ServiceId): boolean;
  specError(service: ServiceId): string | null;
  send(input: SendInput & { confirmToken?: string }): Promise<SendOutcome>;
  runPreset(presetId: string, service: ServiceId): Promise<{ ok: boolean; error?: string; results: PresetRunResult[] }>;
}

const Ctx = createContext<CommandsCtx | null>(null);

export function useCommands(): CommandsCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCommands outside CommandsProvider');
  return c;
}

/** One command by id, kept live by the SSE patches while the stream is subscribed. */
export function useCommand(commandId: string | null | undefined): CommandDTO | null {
  const { history } = useCommands();
  return commandId ? (history[commandId] ?? null) : null;
}

const IN_FLIGHT = new Set(['pending', 'accepted', 'in_progress']);
const LINGER_MS = 10_000;

export function CommandsProvider({ children }: { children: ReactNode }) {
  const { require, invalidate } = useResearcher();
  const [history, setHistory] = useState<Record<string, CommandDTO>>({});
  const [specsByService, setSpecsByService] = useState<Partial<Record<ServiceId, CommandSpecDTO[]>>>({});
  const [presetsByService, setPresetsByService] = useState<Partial<Record<ServiceId, PresetDTO[]>>>({});
  const [specErrors, setSpecErrors] = useState<Partial<Record<ServiceId, string>>>({});
  const [wantLive, setWantLive] = useState(false);
  const fetching = useRef(new Set<ServiceId>());

  // the history panel has to show what happened before this page was opened
  useEffect(() => {
    let alive = true;
    api
      .get<CommandDTO[]>('/api/commands?limit=200')
      .then((rows) => alive && setHistory((prev) => ({ ...Object.fromEntries(rows.map((c) => [c.commandId, c])), ...prev })))
      .catch(() => {
        /* the stream (or the next command) fills the history in */
      });
    return () => {
      alive = false;
    };
  }, []);

  const status = useSse(wantLive ? 'commands' : null, (env) => {
    if (env.type === 'snapshot') {
      const d = env.data as { commands?: CommandDTO[] };
      setHistory((prev) => ({
        ...Object.fromEntries((d.commands ?? []).map((c) => [c.commandId, c])),
        ...prev,
      }));
      return;
    }
    if (env.type === 'patch') setHistory((prev) => mergePatch(prev, env.data as Record<string, CommandDTO | null>));
  });

  // subscribe only while something is in flight, and linger briefly so the last ack is seen
  const inFlight = useMemo(() => Object.values(history).some((c) => IN_FLIGHT.has(c.state)), [history]);
  useEffect(() => {
    if (inFlight) {
      setWantLive(true);
      return;
    }
    const t = setTimeout(() => setWantLive(false), LINGER_MS);
    return () => clearTimeout(t);
  }, [inFlight]);

  const ensure = useCallback(
    (service: ServiceId) => {
      if (specsByService[service] || fetching.current.has(service)) return;
      fetching.current.add(service);
      void Promise.all([
        api.get<{ service: ServiceId; controls: CommandSpecDTO[] }>(`/api/commands/specs/${service}`),
        api.get<PresetDTO[]>(`/api/presets?service=${service}`),
      ])
        .then(([s, p]) => {
          setSpecsByService((prev) => ({ ...prev, [service]: s.controls }));
          setPresetsByService((prev) => ({ ...prev, [service]: p }));
          setSpecErrors((prev) => ({ ...prev, [service]: null }));
        })
        .catch((err) => setSpecErrors((prev) => ({ ...prev, [service]: errorText(err) })))
        .finally(() => fetching.current.delete(service));
    },
    [specsByService, fetching],
  );

  const specs = useCallback((service: ServiceId) => specsByService[service] ?? [], [specsByService]);
  const presets = useCallback((service: ServiceId) => presetsByService[service] ?? [], [presetsByService]);
  const specsLoading = useCallback(
    (service: ServiceId) => specsByService[service] === undefined && !specErrors[service],
    [specsByService, specErrors],
  );
  const specError = useCallback((service: ServiceId) => specErrors[service] ?? null, [specErrors]);

  const send = useCallback(
    async (input: SendInput & { confirmToken?: string }): Promise<SendOutcome> => {
      const code = await require(input.service, `send a ${input.control} command`);
      if (!code) return { ok: false, error: 'No researcher code: nothing was sent.' };
      try {
        const r = await api.post<{ command: CommandDTO }>(
          '/api/commands',
          { ...input },
          { researcher: code },
        );
        setHistory((prev) => ({ ...prev, [r.command.commandId]: r.command }));
        setWantLive(true);
        return { ok: true, commandId: r.command.commandId };
      } catch (err) {
        if (err instanceof ApiError && err.status === 403 && err.code.startsWith('researcher_')) invalidate(input.service);
        if (err instanceof ApiError && err.status === 428) {
          const b = (err.body ?? {}) as Partial<CommandConfirmDTO>;
          return {
            ok: false,
            confirm: {
              title: b.title ?? err.detail,
              facts: b.facts ?? [],
              token: b.token ?? '',
              expiresAtTs: b.expiresAtTs ?? Date.now() + 60_000,
            },
          };
        }
        return { ok: false, error: errorText(err) };
      }
    },
    [require, invalidate],
  );

  const runPreset = useCallback(
    async (presetId: string, service: ServiceId) => {
      const code = await require(service, 'run a preset');
      if (!code) return { ok: false, error: 'No researcher code: nothing was sent.', results: [] };
      try {
        const r = await api.post<{ ok: boolean; results: PresetRunResult[] }>(
          `/api/presets/${encodeURIComponent(presetId)}/run`,
          {},
          { researcher: code },
        );
        if (r.results.some((x) => x.commandId)) setWantLive(true);
        return { ok: r.ok, results: r.results };
      } catch (err) {
        if (err instanceof ApiError && err.status === 403 && err.code.startsWith('researcher_')) invalidate(service);
        return { ok: false, error: errorText(err), results: [] };
      }
    },
    [require, invalidate],
  );

  const value = useMemo(
    () => ({ status, history, specs, presets, ensure, specsLoading, specError, send, runPreset }),
    [status, history, specs, presets, ensure, specsLoading, specError, send, runPreset],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
