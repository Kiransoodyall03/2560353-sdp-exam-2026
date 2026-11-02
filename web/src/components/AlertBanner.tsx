// Pinned annunciator strip. It sits between the nav rail and the page and never scrolls, so the
// alarm state of the whole platform is always on screen.
import { Link } from 'react-router-dom';
import type { AlertDTO } from '../../../shared/types';
import { fmtAgo, fmtTs } from '../lib/format';
import { useLive } from '../lib/live';
import { SeverityBadge } from './ui';

export function AlertBanner() {
  const { summary, alerts, overview, overviewStatus, simNow } = useLive();
  const crit = summary?.unacked.critical ?? 0;
  const warn = summary?.unacked.warning ?? 0;
  const info = summary?.unacked.info ?? 0;
  const newest = newestCritical(alerts);
  const broker = overview?.platform.broker.connected;
  const api = overview?.platform.api.reachable;
  const degraded = overview?.platform.ingestion.degraded;

  return (
    <div className="arl-strip" role="status" aria-live="polite">
      <Link to="/alerts?op=unacked" className="arl-strip__link" title="Open the annunciator">
        <span className="arl-strip__counts">
          <SeverityBadge severity="critical" unacked={crit > 0}>
            {crit} critical
          </SeverityBadge>
          <SeverityBadge severity="warning" unacked={warn > 0}>
            {warn} warning
          </SeverityBadge>
          <SeverityBadge severity="info">{info} info</SeverityBadge>
        </span>
        <span className="arl-strip__msg">
          {newest ? (
            <>
              <strong>{newest.service}</strong> {newest.message}{' '}
              <span className="arl-strip__age">({fmtAgo(newest.raisedTs, simNow)})</span>
            </>
          ) : (
            <>No unacknowledged critical alerts · {summary?.open ?? 0} open</>
          )}
        </span>
      </Link>
      <span className="arl-strip__flags">
        {overviewStatus !== 'open' && (
          <span className="flag bad">
            <SeverityBadge severity="critical" compact /> Live stream {overviewStatus}
          </span>
        )}
        {broker === false && (
          <span className="flag bad">
            <SeverityBadge severity="critical" compact /> Broker disconnected
          </span>
        )}
        {api === false && (
          <span className="flag warn">
            <SeverityBadge severity="warning" compact /> ARL API unreachable
          </span>
        )}
        {degraded && (
          <span className="flag warn">
            <SeverityBadge severity="warning" compact /> Ingestion degraded
          </span>
        )}
      </span>
      <span className="arl-strip__time">Sim time {fmtTs(simNow)}</span>
    </div>
  );
}

/** The most recently raised unacknowledged critical alert, if any. */
function newestCritical(alerts: Record<string, AlertDTO>): AlertDTO | null {
  let best: AlertDTO | null = null;
  for (const a of Object.values(alerts)) {
    if (a.opState !== 'unacked' || a.severity !== 'critical' || a.svcState !== 'raised') continue;
    if (best === null || (a.raisedTs ?? 0) > (best.raisedTs ?? 0)) best = a;
  }
  return best;
}
