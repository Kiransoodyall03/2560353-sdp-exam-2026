// Persistent banner on every page: unacknowledged critical/warning counts, links to the annunciator.
import { Link } from 'react-router-dom';
import { useLive } from '../lib/live';

export function AlertBanner() {
  const { summary, overview, overviewStatus } = useLive();
  const crit = summary?.unacked.critical ?? 0;
  const warn = summary?.unacked.warning ?? 0;
  const info = summary?.unacked.info ?? 0;
  const broker = overview?.platform.broker.connected;
  const api = overview?.platform.api.reachable;
  const degraded = overview?.platform.ingestion.degraded;

  return (
    <div className={`banner ${crit ? 'banner-crit' : warn ? 'banner-warn' : 'banner-ok'}`} role="status" aria-live="polite">
      <Link to="/alerts?op=unacked" className="banner-counts">
        <span className={`count sev-critical ${crit ? 'blink' : ''}`}>
          <span aria-hidden="true">▲</span> {crit} critical
        </span>
        <span className={`count sev-warning ${warn ? 'blink-slow' : ''}`}>
          <span aria-hidden="true">◆</span> {warn} warning
        </span>
        <span className="count sev-info">
          <span aria-hidden="true">●</span> {info} info
        </span>
        <span className="muted">unacknowledged · {summary?.open ?? 0} open</span>
      </Link>
      <div className="banner-flags">
        {overviewStatus !== 'open' && <span className="flag bad">▲ Live stream {overviewStatus}</span>}
        {broker === false && <span className="flag bad">▲ Broker disconnected</span>}
        {api === false && <span className="flag warn">◆ ARL API unreachable</span>}
        {degraded && <span className="flag warn">◆ Ingestion degraded</span>}
      </div>
    </div>
  );
}
