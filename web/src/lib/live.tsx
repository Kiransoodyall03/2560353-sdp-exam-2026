// App-wide live streams: platform overview + open alerts. Every page reads these (nav badges, alert banner).
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AlertDTO, AlertSummaryDTO, OverviewDTO } from '../../../shared/types';
import { useSse, type SseStatus } from './sse';

interface LiveCtx {
  overview: OverviewDTO | null;
  overviewStatus: SseStatus;
  alerts: Record<string, AlertDTO>;
  summary: AlertSummaryDTO | null;
  alertsStatus: SseStatus;
  /** Sim time of the latest message on either stream. */
  simNow: number | null;
  /** Wall time the latest overview arrived (staleness of the UI itself). */
  overviewWallTs: number | null;
}

const Ctx = createContext<LiveCtx | null>(null);

export function useLive(): LiveCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useLive outside LiveProvider');
  return c;
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<OverviewDTO | null>(null);
  const [overviewWallTs, setOverviewWallTs] = useState<number | null>(null);
  const [alerts, setAlerts] = useState<Record<string, AlertDTO>>({});
  const [summary, setSummary] = useState<AlertSummaryDTO | null>(null);
  const [simNow, setSimNow] = useState<number | null>(null);

  const overviewStatus = useSse('overview', (env) => {
    const d = env.data as { overview?: OverviewDTO };
    if (d.overview) {
      setOverview(d.overview);
      setOverviewWallTs(Date.now());
    }
    if (env.simTs) setSimNow(env.simTs);
  });

  const alertsStatus = useSse('alerts', (env) => {
    if (env.simTs) setSimNow(env.simTs);
    if (env.type === 'snapshot') {
      const d = env.data as { alerts: AlertDTO[]; summary: AlertSummaryDTO };
      setAlerts(Object.fromEntries(d.alerts.map((a) => [a.key, a])));
      setSummary(d.summary);
      return;
    }
    if (env.type !== 'patch') return;
    const d = env.data as Record<string, unknown>;
    if (d['summary']) setSummary(d['summary'] as AlertSummaryDTO);
    setAlerts((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(d)) {
        if (k === 'summary') continue;
        const a = v as AlertDTO | null;
        if (!a || a.opState === 'resolved') delete next[k];
        else next[k] = a;
      }
      return next;
    });
  });

  const value = useMemo(
    () => ({ overview, overviewStatus, alerts, summary, alertsStatus, simNow, overviewWallTs }),
    [overview, overviewStatus, alerts, summary, alertsStatus, simNow, overviewWallTs],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
