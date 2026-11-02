// One source of truth for "what does this service look like right now". Live is the normal path: each
// service keeps its own typed live hook (useRtaLive / useOpgLive / useLwmLive) fed by its SSE channel. This
// module only adds the replay side, so those hooks — and therefore every page — follow the replay clock with
// no page-level rewiring. It also centralises the two things STEP 2 needs everywhere: the alerts as the
// current mode sees them, and the single "controls are disabled in replay" message + button props.
import { useMemo } from 'react';
import type { AlertDTO, AlertSummaryDTO } from '../../../shared/types';
import { useLive } from './live';
import { useReplay, type ServiceReplayState } from './replay';
import type { SseStatus } from './sse';

/** The tooltip every disabled control shows in replay, and the detail the server returns with a 409. */
export const REPLAY_DISABLED_MSG = 'Replay mode: controls are disabled.';

/**
 * The replay state for one service at the cursor, or null while live (or before the session has folded).
 * `view` is the plugin's own snapshot — the exact shape its live SSE channel sends (RTA {dishes, subarrays,
 * global, scans}, OPG {plant}, LWM {network}) — so a live hook feeds it through its existing snapshot parser.
 */
export function useServiceState(service: string): ServiceReplayState | null {
  const { isReplaying, state } = useReplay();
  return useMemo(() => {
    if (!isReplaying || !state) return null;
    return state.services[service] ?? null;
  }, [isReplaying, state, service]);
}

/** True while a replay session is active: the signal every control / preset / ack / resolve button disables on. */
export function useReplayLocked(): boolean {
  return useReplay().isReplaying;
}

/**
 * Props to spread on a button that must be disabled in replay: {disabled, title}. `base` is the button's own
 * disable condition (busy, not-ready…), which is OR-ed with the replay lock so both reasons are honoured.
 */
export function replayLockProps(locked: boolean, base = false): { disabled: boolean; title?: string } {
  return locked ? { disabled: true, title: REPLAY_DISABLED_MSG } : { disabled: base };
}

export interface AlertsState {
  /** Alerts to show: the live stream normally, the folded alerts at the cursor while replaying. */
  alerts: AlertDTO[];
  summary: AlertSummaryDTO | null;
  replaying: boolean;
  status: SseStatus;
}

/** Alerts as the current mode sees them: live from the alerts stream, replay from the session state at t. */
export function useAlertsState(): AlertsState {
  const live = useLive();
  const { isReplaying, state } = useReplay();
  return useMemo(() => {
    if (isReplaying && state) {
      return { alerts: state.alerts.alerts, summary: state.alerts.summary, replaying: true, status: 'open' };
    }
    return { alerts: Object.values(live.alerts), summary: live.summary, replaying: false, status: live.alertsStatus };
  }, [isReplaying, state, live.alerts, live.summary, live.alertsStatus]);
}
