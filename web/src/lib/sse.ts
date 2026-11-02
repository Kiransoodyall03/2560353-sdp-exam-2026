// EventSource hook for /api/stream/:channel. The server sends a snapshot on connect, then coalesced keyed
// patches (null = removed) and appends. EventSource reconnects by itself; each reconnect gets a fresh snapshot.
import { useEffect, useRef, useState } from 'react';
import type { SseEnvelope } from '../../../shared/types';

export type SseStatus = 'connecting' | 'open' | 'closed';

export function useSse(channel: string | null, onMessage: (env: SseEnvelope) => void): SseStatus {
  const [status, setStatus] = useState<SseStatus>('connecting');
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (!channel) return;
    setStatus('connecting');
    const es = new EventSource(`/api/stream/${encodeURIComponent(channel)}`);
    es.onopen = () => setStatus('open');
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting');
    es.onmessage = (ev: MessageEvent<string>) => {
      let env: SseEnvelope;
      try {
        env = JSON.parse(ev.data) as SseEnvelope;
      } catch {
        return;
      }
      handler.current(env);
    };
    return () => es.close();
  }, [channel]);

  return status;
}

/** Keyed-map channel state: snapshot replaces, patch merges (null deletes). */
export function useKeyedChannel<T>(
  channel: string | null,
  fromSnapshot: (data: unknown) => Record<string, T>,
): { items: Record<string, T>; status: SseStatus; simTs: number | null } {
  const [items, setItems] = useState<Record<string, T>>({});
  const [simTs, setSimTs] = useState<number | null>(null);
  const snap = useRef(fromSnapshot);
  snap.current = fromSnapshot;
  const status = useSse(channel, (env) => {
    setSimTs(env.simTs);
    if (env.type === 'snapshot') setItems(snap.current(env.data));
    else if (env.type === 'patch') setItems((prev) => mergePatch(prev, env.data as Record<string, T | null>));
  });
  return { items, status, simTs };
}

export function mergePatch<T>(prev: Record<string, T>, patch: Record<string, T | null>): Record<string, T> {
  const next = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}
