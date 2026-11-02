// Generic live view for a service without a dedicated plugin UI yet (LWM, OPG): health + entity table
// driven by $topology and the `svc:<id>` stream.
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isServiceId, type AlertService, type ServiceTopology } from '../../../shared/types';
import { Empty, KpiTile, Loading, Panel, SeverityBadge, StatusPill } from '../components/ui';
import { fmtAgo, fmtAny, fmtTs } from '../lib/format';
import { SERVICE_TEXT } from '../lib/labels';
import { useLive } from '../lib/live';
import { useKeyedChannel } from '../lib/sse';

interface EntityState {
  id: string;
  state: Record<string, { value: unknown; ts: number | null }>;
  telemetry: Record<string, { fields: Record<string, unknown>; ts: number }>;
  lastTs: number | null;
}

export function ServicePage() {
  const { svc = '' } = useParams();
  const live = useLive();
  const valid = isServiceId(svc);
  const { items, status } = useKeyedChannel<unknown>(valid ? `svc:${svc}` : null, (d) => d as Record<string, unknown>);
  const topology = items['$topology'] as ServiceTopology | null | undefined;
  const entities = useMemo(
    () =>
      Object.entries(items)
        .filter(([k]) => k.startsWith('entity:'))
        .map(([, v]) => v as EntityState)
        .sort((a, b) => a.id.localeCompare(b.id)),
    [items],
  );
  if (!valid) return <Empty>Unknown service “{svc}”.</Empty>;
  const ov = live.overview?.services.find((s) => s.health.service === svc);
  const h = ov?.health;
  const simNow = h?.simNow ?? live.simNow;
  const kinds = new Map(topology?.entities.map((e) => [e.id, e.kind]) ?? []);
  const silent = new Set(h?.silent.map((s) => `${s.entity}/${s.stream}`) ?? []);
  const alertsFor = (id: string) => Object.values(live.alerts).filter((a) => a.service === svc && a.entity === id).length;

  const name = valid ? (SERVICE_TEXT[svc as AlertService] ?? svc) : svc;

  return (
    <div className="page">
      <h1 className="row gap">
        <span>{name}</span>
        <StatusPill tone={h?.online === true ? 'ok' : h?.online === false ? 'bad' : 'idle'}>
          {h?.online === true ? 'Online' : h?.online === false ? 'Offline' : 'Unknown'}
        </StatusPill>
        <span className="muted small">{topology ? `topology v${topology.version}` : ''}</span>
      </h1>
      {status !== 'open' && (
        <div className="flag warn">
          <SeverityBadge severity="warning" compact /> Live stream {status}
        </div>
      )}
      <div className="readings">
        {ov?.kpis.slice(0, 3).map((k) => (
          <KpiTile key={k.label} kpi={k} />
        ))}
        <KpiTile kpi={{ label: 'Open alerts', value: ov?.alerts.open ?? 0, status: ov?.alerts.unacked ? 'warn' : 'ok' }} />
      </div>
      <Panel
        title={`Entities (${entities.length})`}
        actions={
          <Link to={`/alerts?service=${svc}`} className="arl-btn">
            Alerts for {name}
          </Link>
        }
      >
        {!topology && entities.length === 0 ? (
          <Loading what="entities" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Kind</th>
                  <th>Last data</th>
                  <th>State</th>
                  <th>Latest telemetry</th>
                  <th>Alerts</th>
                </tr>
              </thead>
              <tbody>
                {entities.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.id}</td>
                    <td>{kinds.get(e.id) ?? '—'}</td>
                    <td>
                      <span title={fmtAgo(e.lastTs, simNow)}>{fmtTs(e.lastTs)}</span>
                    </td>
                    <td className="small">
                      {Object.entries(e.state).map(([k, v]) => (
                        <div key={k}>
                          <span className="muted">{k}</span> {fmtAny(v.value)}
                        </div>
                      ))}
                    </td>
                    <td className="small">
                      {Object.entries(e.telemetry).map(([stream, t]) => (
                        <div key={stream}>
                          <StatusPill tone={silent.has(`${e.id}/${stream}`) ? 'warn' : 'ok'}>{stream}</StatusPill>{' '}
                          {Object.entries(t.fields)
                            .slice(0, 8)
                            .map(([k, v]) => `${k}=${fmtAny(v)}`)
                            .join('  ')}
                        </div>
                      ))}
                    </td>
                    <td>{alertsFor(e.id) || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
