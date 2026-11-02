import { Link } from 'react-router-dom';
import type { ServiceHealthDTO, ServiceOverviewDTO } from '../../../shared/types';
import { KpiTile, Loading, Panel, StatusPill, type Tone } from '../components/ui';
import { fmtAgo, fmtDuration, fmtNum, fmtTime, fmtTs } from '../lib/format';
import { useLive } from '../lib/live';

const NAMES: Record<string, string> = {
  rta: 'Radio telescope array',
  lwm: 'Local weather monitoring',
  opg: 'Outpost power grid',
};
/** Wall-clock silence after which a service counts as stale. */
const STALE_WALL_MS = 15_000;

export function OverviewPage() {
  const { overview } = useLive();
  if (!overview) return <Loading what="overview" />;
  const p = overview.platform;
  const a = overview.alerts;
  const live = overview.services.filter((s) => !isStale(s.health, p.wallTs) && s.health.online === true).length;
  const unacked = a.unacked.critical + a.unacked.warning + a.unacked.info;
  const down = overview.services.length - live;

  return (
    <div className="page">
      <h1>Overview</h1>

      <div className="readings">
        <KpiTile
          kpi={{
            label: 'Services reporting',
            value: `${live} of ${overview.services.length}`,
            status: down > 0 ? 'warn' : 'ok',
          }}
          cause={
            down > 0
              ? `${down} service${down === 1 ? '' : 's'} silent for more than ${STALE_WALL_MS / 1000} s.`
              : 'All services reported data in the last 15 s.'
          }
        />
        <KpiTile
          kpi={{
            label: 'Unacknowledged alerts',
            value: unacked,
            status: a.unacked.critical > 0 ? 'bad' : a.unacked.warning > 0 ? 'warn' : 'ok',
          }}
          cause={`${a.unacked.critical} critical, ${a.unacked.warning} warning, ${a.unacked.info} info.`}
        />
        <KpiTile
          kpi={{ label: 'Open alerts', value: a.open }}
          cause={`${a.raised} raised since the last reset.`}
        />
        <KpiTile
          kpi={{
            label: 'Ingestion',
            value: fmtNum(p.ingestion.msgPerSec, 0),
            unit: 'msg/s',
            status: p.ingestion.degraded ? 'warn' : 'ok',
          }}
          cause={
            p.ingestion.degraded
              ? `Degraded: ${p.ingestion.queueDepth} queued, ${p.ingestion.rawOnly} stored raw only.`
              : `Queue ${p.ingestion.queueDepth}, flush ${p.ingestion.lastFlushMs == null ? '—' : `${fmtNum(p.ingestion.lastFlushMs, 0)} ms`}.`
          }
        />
      </div>

      <Panel title="Services" actions={<Link to="/alerts">Annunciator</Link>}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Service</th>
                <th>State</th>
                <th>Last data</th>
                <th>Unacked</th>
                <th>Open</th>
                <th>Entities</th>
                <th>Topology</th>
              </tr>
            </thead>
            <tbody>
              {overview.services.map((s) => (
                <ServiceRow key={s.health.service} s={s} wallNow={p.wallTs} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Platform">
        <div className="kv-grid">
          <div>
            <div className="kv-k">MQTT broker</div>
            <StatusPill tone={p.broker.connected ? 'ok' : 'bad'}>
              {p.broker.connected ? 'Connected' : 'Disconnected'}
            </StatusPill>
            <div className="muted small">
              {p.broker.reconnects} reconnects{p.broker.error ? ` · ${p.broker.error}` : ''}
            </div>
          </div>
          <div>
            <div className="kv-k">ARL API</div>
            <StatusPill tone={p.api.reachable === null ? 'idle' : p.api.reachable ? 'ok' : 'bad'}>
              {p.api.reachable === null ? 'Checking' : p.api.reachable ? (p.api.status ?? 'Reachable') : 'Unreachable'}
            </StatusPill>
            <div className="muted small" title={fmtAgo(p.api.lastCheckWallTs, p.wallTs)}>
              checked {fmtTime(p.api.lastCheckWallTs)}
            </div>
          </div>
          <div>
            <div className="kv-k">Ingestion</div>
            <StatusPill tone={p.ingestion.degraded ? 'warn' : 'ok'}>
              {p.ingestion.degraded ? 'Degraded (raw only)' : 'Normal'}
            </StatusPill>
            <div className="muted small">
              {fmtNum(p.ingestion.msgPerSec, 0)} msg/s · queue {p.ingestion.queueDepth} · flush{' '}
              {p.ingestion.lastFlushMs == null ? '—' : `${fmtNum(p.ingestion.lastFlushMs, 0)} ms`}
            </div>
          </div>
          <div>
            <div className="kv-k">Stored</div>
            <div className="arl-num">{p.ingestion.written.toLocaleString()} rows</div>
            <div className="muted small">
              {p.ingestion.rawOnly.toLocaleString()} raw only · {p.ingestion.dropped.toLocaleString()} dropped
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function isStale(h: ServiceHealthDTO, wallNow: number): boolean {
  return h.lastSeenWallTs === null || wallNow - h.lastSeenWallTs > STALE_WALL_MS;
}

function ServiceRow({ s, wallNow }: { s: ServiceOverviewDTO; wallNow: number }) {
  const h = s.health;
  const stale = isStale(h, wallNow);
  const tone: Tone = h.online === false ? 'bad' : h.online === null ? 'idle' : stale ? 'warn' : 'ok';
  const state = h.online === false ? 'Offline' : h.online === null ? 'Unknown' : stale ? 'Stale' : 'Online';
  return (
    <tr>
      <td>
        <Link to={`/${h.service}`}>{NAMES[h.service] ?? h.service}</Link>
        <div className="muted small">{h.service}</div>
      </td>
      <td className="small">
        <StatusPill tone={tone}>{state}</StatusPill>
      </td>
      <td title={fmtAgo(h.lastSeenSimTs, h.simNow)}>
        {fmtTs(h.lastSeenSimTs)}
        {h.online && h.onlineSinceTs ? (
          <div className="muted small">up {fmtDuration((h.simNow ?? 0) - h.onlineSinceTs)}</div>
        ) : null}
      </td>
      <td>{s.alerts.unacked}</td>
      <td>{s.alerts.open}</td>
      <td>{h.entityCount}</td>
      <td>{h.topologyVersion ? `v${h.topologyVersion}` : '—'}</td>
    </tr>
  );
}
