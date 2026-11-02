// Replay session state for the whole app. One provider owns the live/replay mode, the session cursor and the
// per-service state at that cursor; the bottom bar drives it and the pages read from it (STEP 2). Replay is
// read-only: while a session is active every fetch carries `x-replay-session`, so the server refuses control
// routes with a 409 (see server/src/routes/replay.ts). The session is deleted on exit, on unmount and on page
// unload so we never leak one of the engine's ten slots.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AlertDTO, AlertSummaryDTO, KpiDTO, ServiceTopology } from '../../../shared/types';
import { api, errorText, setReplayHeader } from './api';
import { useLive } from './live';
import { clampWindow, DEFAULT_WINDOW_MS, type ReplayRangeDTO, type Speed, type Window } from './replay-utils';
import { useSse } from './sse';

// ---- mirrors of the server replay DTOs (the web cannot import server files: they pull in node deps) ----
export interface ReplaySessionDTO {
  id: string;
  t: number;
  speed: Speed;
  playing: boolean;
  from: number;
  to: number;
  createdAt: number;
}
export interface ReplayEntityState {
  id: string;
  state: Record<string, { value: unknown; ts: number | null }>;
  telemetry: Record<string, { fields: Record<string, unknown>; ts: number }>;
  lastTs: number | null;
}
export interface ReplayServiceState {
  service: string;
  entities: Record<string, ReplayEntityState>;
  messages: number;
  lastSimTs: number | null;
  lastRecvTs: number | null;
}
/** One service at the cursor: the plugin's own view (same shape its live snapshot has) plus generic state. */
export interface ServiceReplayState {
  view: unknown | null;
  state: ReplayServiceState;
  topology: ServiceTopology | null;
  kpis: KpiDTO[];
}
export interface ReplayAlertsDTO {
  alerts: AlertDTO[];
  summary: AlertSummaryDTO;
}
export interface ReplayStateDTO {
  id: string;
  t: number;
  from: number;
  to: number;
  speed: Speed;
  playing: boolean;
  services: Record<string, ServiceReplayState>;
  alerts: ReplayAlertsDTO;
}

export interface ReplayCtx {
  mode: 'live' | 'replay';
  isReplaying: boolean;
  sessionId: string | null;
  /** Replay cursor (sim ms) when replaying; null while live. */
  t: number | null;
  speed: Speed;
  playing: boolean;
  range: ReplayRangeDTO | null;
  error: string | null;
  busy: boolean;
  /** Full per-service state + alerts at the cursor (null while live). */
  state: ReplayStateDTO | null;
  /** The visible trailing window on the track (clamped to the stored range). */
  win: Window | null;
  presetMs: number;
  /** What the track playhead draws: the replay cursor, or live sim time clamped to the window. */
  playhead: number | null;
  setPresetMs: (ms: number) => void;
  enterReplay: (t: number) => Promise<void>;
  exitReplay: () => Promise<void>;
  toggle: () => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (t: number) => void;
  setSpeed: (s: Speed) => void;
  step: (dir: 1 | -1) => void;
}

const Ctx = createContext<ReplayCtx | null>(null);

export function useReplay(): ReplayCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useReplay outside ReplayProvider');
  return c;
}

/** Coalesce the throttled SSE patch (keys t / playing / speed / svc:<name> / alerts) into the current state. */
function applyPatch(prev: ReplayStateDTO | null, d: Record<string, unknown>): ReplayStateDTO | null {
  if (!prev) return prev;
  const next: ReplayStateDTO = { ...prev, services: { ...prev.services } };
  if (typeof d['t'] === 'number') next.t = d['t'];
  if (typeof d['playing'] === 'boolean') next.playing = d['playing'];
  if (typeof d['speed'] === 'number') next.speed = d['speed'] as Speed;
  const alerts = d['alerts'];
  if (alerts && typeof alerts === 'object') next.alerts = alerts as ReplayAlertsDTO;
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith('svc:') && v && typeof v === 'object') next.services[k.slice(4)] = v as ServiceReplayState;
  }
  return next;
}

export function ReplayProvider({ children }: { children: ReactNode }) {
  const { simNow } = useLive();
  const [range, setRange] = useState<ReplayRangeDTO | null>(null);
  const [presetMs, setPresetMsState] = useState<number>(DEFAULT_WINDOW_MS);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<ReplayStateDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Refs so the SSE cleanup and the async actions always see the latest values without re-subscribing.
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  const loadRange = useCallback(() => {
    api
      .get<ReplayRangeDTO>('/api/replay/range')
      .then((r) => setRange(r))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    loadRange();
  }, [loadRange]);
  // While live, refresh the range so the trailing window keeps ending at the newest stored message.
  useEffect(() => {
    if (sessionId) return;
    const id = setInterval(loadRange, 60_000);
    return () => clearInterval(id);
  }, [sessionId, loadRange]);

  const win = useMemo(() => clampWindow(range, presetMs), [range, presetMs]);
  const mode: 'live' | 'replay' = sessionId ? 'replay' : 'live';
  const t = state?.t ?? null;
  const speed: Speed = state?.speed ?? 1;
  const playing = state?.playing ?? false;

  const playhead = useMemo(() => {
    if (!win) return null;
    if (mode === 'replay' && t != null) return Math.min(Math.max(t, win.from), win.to);
    if (simNow != null) return Math.min(Math.max(simNow, win.from), win.to);
    return win.to;
  }, [win, mode, t, simNow]);
  const playheadRef = useRef<number | null>(null);
  playheadRef.current = playhead;

  // The session channel pushes a snapshot on connect then throttled deltas; simTs on the envelope is the LIVE
  // clock, so the cursor is read from the payload's own `t`, never from env.simTs.
  const channel = sessionId ? `replay:${sessionId}` : null;
  useSse(channel, (env) => {
    if (env.type === 'snapshot') {
      const d = env.data as ReplayStateDTO;
      if (d && typeof d === 'object' && d.services) setState(d);
      return;
    }
    if (env.type === 'patch') setState((prev) => applyPatch(prev, env.data as Record<string, unknown>));
  });

  // Merge a control response (the session) into the cursor fields; the services arrive on the forced SSE patch.
  const applySession = useCallback((s: ReplaySessionDTO) => {
    setState((prev) => (prev ? { ...prev, t: s.t, speed: s.speed, playing: s.playing, from: s.from, to: s.to } : prev));
  }, []);

  const control = useCallback(
    async (path: 'play' | 'pause' | 'seek' | 'speed' | 'step', body?: unknown) => {
      const id = sessionRef.current;
      if (!id) return;
      try {
        const s = await api.post<ReplaySessionDTO>(`/api/replay/${id}/${path}`, body ?? {});
        applySession(s);
        setError(null);
      } catch (e) {
        setError(errorText(e));
      }
    },
    [applySession],
  );

  const enterReplay = useCallback(async (atT: number) => {
    if (sessionRef.current) {
      void control('seek', { t: atT });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await api.post<ReplaySessionDTO>('/api/replay', { t: atT, speed: 1 });
      sessionRef.current = session.id;
      setReplayHeader(session.id);
      setSessionId(session.id);
      // Seed the full state now; the SSE snapshot + patches keep it fresh from here on.
      const dto = await api.get<ReplayStateDTO>(`/api/replay/${session.id}/state`);
      setState(dto);
    } catch (e) {
      setError(errorText(e));
      setReplayHeader(null);
      sessionRef.current = null;
      setSessionId(null);
      setState(null);
    } finally {
      setBusy(false);
    }
  }, [control]);

  const exitReplay = useCallback(async () => {
    const id = sessionRef.current;
    // Clear the header first so the next live control request is not refused with a 409.
    setReplayHeader(null);
    sessionRef.current = null;
    setSessionId(null);
    setState(null);
    setError(null);
    if (id) {
      try {
        await api.del(`/api/replay/${id}`);
      } catch {
        /* idempotent: the engine reaps idle sessions on its own */
      }
    }
  }, []);

  const toggle = useCallback(async () => {
    if (sessionRef.current) {
      await exitReplay();
      return;
    }
    const at = playheadRef.current ?? range?.overall.max ?? null;
    if (at == null) {
      setError('No stored data to replay yet.');
      return;
    }
    await enterReplay(at);
  }, [exitReplay, enterReplay, range]);

  const setPresetMs = useCallback(
    (ms: number) => {
      setPresetMsState(ms);
      // Keep the cursor inside the new window so the playhead never sits off the end of the track.
      const next = clampWindow(range, ms);
      if (sessionRef.current && next && t != null && (t < next.from || t > next.to)) {
        void control('seek', { t: next.to });
      }
    },
    [range, t, control],
  );

  // Drop the session on unmount and on page unload (keepalive so the DELETE survives the navigation).
  useEffect(() => {
    const drop = () => {
      const id = sessionRef.current;
      if (!id) return;
      setReplayHeader(null);
      sessionRef.current = null;
      fetch(`/api/replay/${id}`, { method: 'DELETE', headers: { accept: 'application/json' }, keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', drop);
    return () => {
      window.removeEventListener('pagehide', drop);
      drop();
    };
  }, []);

  const value = useMemo<ReplayCtx>(
    () => ({
      mode,
      isReplaying: mode === 'replay',
      sessionId,
      t,
      speed,
      playing,
      range,
      error,
      busy,
      state,
      win,
      presetMs,
      playhead,
      setPresetMs,
      enterReplay,
      exitReplay,
      toggle,
      play: () => void control('play'),
      pause: () => void control('pause'),
      togglePlay: () => void control(playing ? 'pause' : 'play'),
      seek: (atT: number) => void control('seek', { t: atT }),
      setSpeed: (s: Speed) => void control('speed', { speed: s }),
      step: (dir: 1 | -1) => void control('step', { direction: dir }),
    }),
    [mode, sessionId, t, speed, playing, range, error, busy, state, win, presetMs, playhead, setPresetMs, enterReplay, exitReplay, toggle, control],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
