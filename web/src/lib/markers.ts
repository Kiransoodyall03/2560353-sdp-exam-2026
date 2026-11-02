// Markers for the visible window: alert events, commands and RTA scan start/end, fetched from
// GET /api/replay/markers?from&to and refetched whenever the window moves. Shared by the bottom-bar track
// (STEP 3, which draws them as ticks/bars) and the Replay page (STEP 4, which lists them as an event log).
// A read route, so it is not refused by the replay header; it works live and while replaying alike.
import { useEffect, useRef, useState } from 'react';
import { api, errorText } from './api';
import type { ReplayMarker, ReplayMarkersDTO, Window } from './replay-utils';

export interface MarkersState {
  markers: ReplayMarker[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

/** Fetch the markers inside `win`, cancelling and refetching when the window changes. */
export function useMarkers(win: Window | null): MarkersState {
  const [markers, setMarkers] = useState<ReplayMarker[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);
  const from = win ? Math.round(win.from) : null;
  const to = win ? Math.round(win.to) : null;

  useEffect(() => {
    if (from == null || to == null || to <= from) {
      setMarkers([]);
      setTruncated(false);
      return;
    }
    const req = ++reqRef.current;
    const ac = new AbortController();
    setLoading(true);
    api
      .get<ReplayMarkersDTO>(`/api/replay/markers?from=${from}&to=${to}`, { signal: ac.signal })
      .then((r) => {
        if (reqRef.current !== req) return;
        setMarkers(r.markers);
        setTruncated(r.truncated);
        setError(null);
      })
      .catch((e: unknown) => {
        if (reqRef.current !== req || (e as Error).name === 'AbortError') return;
        setError(errorText(e));
      })
      .finally(() => {
        if (reqRef.current === req) setLoading(false);
      });
    return () => ac.abort();
  }, [from, to]);

  return { markers, truncated, loading, error };
}
