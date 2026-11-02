import { Link } from 'react-router-dom';
import type { ServiceOverviewDTO } from '../../../shared/types';
import { KpiTile, Loading, Panel, StatusPill } from '../components/ui';
import { fmtAgo, fmtDuration, fmtNum, fmtTs } from '../lib/format';
import { useLive } from '../lib/live';

const NAMES: Record<string, string> = { rta: 'Radio Telescope Array', lwm: 'Local Weather Monitoring', opg: 'Outpost Power Grid' };
/** Wall-clock silence after which a tile is drawn as stale. */
const STALE_WALL_MS = 15_000;

export function OverviewPage() {
  const { overview } = useLive();
  if (!overview) return <Loading what="overview" />;
  const p = overview.platform;
  return (
    <div className="page">
      <h1>Overview</h1>
      <div className="tiles">
        {overview.services.map((s) => (
          <ServiceTile key={s.health.service} s={s} wallNow={p.wallTs} />
        ))}
      </div>
      <Panel title="Platform">
        <div className="kv-grid">
          <div>
            <div className="kv-k">MQTT broker</div>
            <StatusPill tone={p.broker.connected ? 'ok' : 'bad'}>{p.broker.connected ? 'connected' : 'disconnected'}</StatusPill>
            <div className="muted small">
              {p.broker.reconnects} reconnects{p.broker.error ? ` · ${p.broker.error}` : ''}
            </div>
          </div>
          <div>
            <div className="kv-k">ARL API</div>
            <StatusPill tone={p.api.reachable === null ? 'idle' : p.api.reachable ? 'ok' : 'bad'}>
              {p.api.reachable === null ? 'checking' : p.api.reachable ? (p.api.status ?? 'ok') : 'unreachable'}
            </StatusPill>
            <div className="muted small">checked {fmtAgo(p.api.lastCheckWallTs, p.wallTs)}</div>
          </div>
          <div>
            <div className="kv-k">Ingestion</div>
            <StatusPill tone={p.ingestion.degraded ? 'warn' : 'ok'}>{p.ingestion.degraded ? 'degraded (raw only)' : 'normal'}</StatusPill>
            <div className="muted small">
              {fmtNum(p.ingestion.msgPerSec, 0)} msg/s · queue {p.ingestion.queueDepth} · flush{' '}
              {p.ingestion.lastFlushMs == null ? '—' : `${fmtNum(p.ingestion.lastFlushMs, 0)} ms`}
            </div>
          </div>
          <div>
            <div className="kv-k">Stored</div>
            <div className="mono">{p.ingestion.written.toLocaleString()} rows</div>
            <div className="muted small">
              {p.ingestion.rawOnly.toLocaleString()} raw-only · {p.ingestion.dropped.toLocaleString()} dropped
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function ServiceTile({ s, wallNow }: { s: ServiceOverviewDTO; wallNow: number }) {
  const h = s.health;
  const stale = h.lastSeenWallTs === null || wallNow - h.lastSeenWallTs > STALE_WALL_MS;
  const tone = h.online === false ? 'bad' : h.online === null ? 'idle' : stale ? 'warn' : 'ok';
  const stateText = h.online === false ? 'offline' : h.online === null ? 'unknown' : stale ? 'stale' : 'online';
  return (
    <Link to={`/${h.service}`} className={`tile ${stale || h.online !== true ? 'tile-stale' : ''}`}>
      <header className="tile-head">
        <div>
          <div className="tile-code">{h.service.toUpperCase()}</div>
          <div className="tile-name">{NAMES[h.service]}</div>
        </div>
        <StatusPill tone={tone}>{stateText}</StatusPill>
      </header>
      <div className="tile-meta muted small">
        last data {fmtAgo(h.lastSeenSimTs, h.simNow)} (sim) · {h.speedup ? `×${fmtNum(h.speedup, 1)}` : 'rate —'}
        {h.online && h.onlineSinceTs ? ` · up ${fmtDuration((h.simNow ?? 0) - h.onlineSinceTs)}` : ''}
      </div>
      <div className="kpis">
        {s.kpis.map((k) => (
          <KpiTile key={k.label} kpi={k} />
        ))}
      </div>
      <footer className="tile-foot">
        <span className={s.alerts.unacked ? 'sev-critical' : 'muted'}>
          {s.alerts.unacked} unacked / {s.alerts.open} open alerts
        </span>
        {h.silent.length > 0 && <span className="sev-warning">◆ {h.silent.length} silent streams</span>}
        {h.seqGaps.outstanding > 0 && <span className="sev-warning">◆ {h.seqGaps.outstanding} seq gaps</span>}
        <span className="muted small" title={fmtTs(h.lastSeenSimTs)}>
          {h.entityCount} entities · v{h.topologyVersion ?? '?'}
        </span>
      </footer>
    </Link>
  );
}
