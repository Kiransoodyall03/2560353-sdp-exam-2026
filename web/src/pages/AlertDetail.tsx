// One alert: metadata, value vs limit, entity link, suggested action, audit timeline, commands issued around
// that time, and the acknowledge → resolve workflow.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AlertDetailDTO, AlertDTO } from '../../../shared/types';
import { alertHref, EntityLink } from '../components/EntityLink';
import { Empty, ErrorBox, Loading, Panel, SeverityBadge, StatusPill } from '../components/ui';
import { useResearcherAction } from '../lib/actions';
import { api, errorText } from '../lib/api';
import { fmtAny, fmtTs } from '../lib/format';
import { useLive } from '../lib/live';
import { valueVsLimit } from './Annunciator';

const ACTION_TEXT: Record<string, string> = {
  raised: 'Raised by service',
  escalated: 'Escalated',
  deescalated: 'De-escalated',
  reraised: 'Raised again',
  reopened: 'Re-opened (needs a new acknowledgement)',
  cleared: 'Cleared by service',
  captured: 'Captured',
  reconciled: 'Confirmed active by service',
  reconciled_placeholder: 'Found active at start-up (raised before capture)',
  cleared_by_reconcile: 'No longer active at the service',
  details_from_backlog: 'Original details filled from ARL API backlog',
  acked: 'Acknowledged',
  resolved: 'Resolved',
};

export function AlertDetailPage() {
  const { service = '', alertId = '' } = useParams();
  const live = useLive();
  const [detail, setDetail] = useState<AlertDetailDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveAlert: AlertDTO | undefined = live.alerts[`${service}:${alertId}`];
  const version = liveAlert?.updatedWallTs;

  const load = useCallback(() => {
    api
      .get<AlertDetailDTO>(`/api/alerts/${service}/${encodeURIComponent(alertId)}`)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((err) => setError(errorText(err)));
  }, [service, alertId]);
  useEffect(load, [load, version]);

  if (error && !detail) return <ErrorBox>Could not load alert: {error}</ErrorBox>;
  if (!detail) return <Loading what="alert" />;
  const a = liveAlert ?? detail.alert;
  const meta = Object.entries(a.metadata).filter(([k]) => k !== 'details_source');

  return (
    <div className="page">
      <p>
        <Link to="/alerts">← Annunciator</Link>
      </p>
      <h1 className="row gap">
        <SeverityBadge severity={a.severity} />
        <span>{a.type}</span>
        <span className="muted mono small">{a.alertId}</span>
      </h1>
      <div className="grid-2">
        <Panel title="Alert">
          <dl className="dl">
            <dt>Service</dt>
            <dd>{a.service.toUpperCase()}</dd>
            <dt>Entity</dt>
            <dd>
              <EntityLink alert={a} />
            </dd>
            <dt>Message</dt>
            <dd>{a.message || '—'}</dd>
            <dt>Value / limit</dt>
            <dd className="mono">{valueVsLimit(a)}</dd>
            <dt>Severity</dt>
            <dd>
              {a.severity}
              {a.maxSeverity !== a.severity && <span className="muted"> (peak {a.maxSeverity})</span>}
            </dd>
            <dt>Condition</dt>
            <dd>
              <StatusPill tone={a.svcState === 'raised' ? 'warn' : 'idle'}>{a.svcState}</StatusPill>
            </dd>
            <dt>Workflow</dt>
            <dd>
              <StatusPill tone={a.opState === 'unacked' ? 'bad' : a.opState === 'acked' ? 'warn' : 'ok'}>{a.opState}</StatusPill>
            </dd>
            <dt>Raised</dt>
            <dd className="mono">{fmtTs(a.raisedTs)}</dd>
            <dt>Cleared</dt>
            <dd className="mono">{fmtTs(a.clearedTs)}</dd>
            {a.placeholder && (
              <>
                <dt>Note</dt>
                <dd className="sev-warning">
                  Raised before the platform started capturing; details shown are{' '}
                  {a.metadata['details_source'] === 'api_backlog' ? 'from the ARL API backlog' : 'defaults until the original event is found'}.
                </dd>
              </>
            )}
            {meta.map(([k, v]) => (
              <FragmentKV key={k} k={k} v={v} />
            ))}
          </dl>
        </Panel>
        <div className="stack">
          <Panel title="Suggested action">
            <p>{detail.suggestion}</p>
          </Panel>
          <WorkflowPanel alert={a} onDone={load} />
        </div>
      </div>
      <div className="grid-2">
        <Panel title="Timeline">
          {detail.events.length === 0 ? (
            <Empty>No events.</Empty>
          ) : (
            <ol className="timeline">
              {detail.events.map((e) => (
                <li key={e.id} className={`tl tl-${e.action}`}>
                  <div className="mono small">{fmtTs(e.simTs ?? e.wallTs)}</div>
                  <div>
                    <strong>{ACTION_TEXT[e.action] ?? e.action}</strong>
                    {e.actor && <span className="muted"> · {String(e.detail['name'] ?? '')} ({e.actor})</span>}
                  </div>
                  <EventDetail detail={e.detail} />
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel title="Commands around this time">
          {detail.commands.length === 0 ? (
            <Empty>No commands were issued on this service in the window around the alert.</Empty>
          ) : (
            <table className="table small">
              <thead>
                <tr>
                  <th>Requested</th>
                  <th>Entity</th>
                  <th>Control</th>
                  <th>Value</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {detail.commands.map((c) => (
                  <tr key={c.commandId}>
                    <td className="mono">{fmtTs(c.requestedTs)}</td>
                    <td className="mono">{c.entity}</td>
                    <td>{c.control}</td>
                    <td className="mono">{fmtAny(c.value)}</td>
                    <td>{c.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
      <p className="muted small">
        Permalink: <Link to={alertHref(a)}>{alertHref(a)}</Link>
      </p>
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className="mono small">{fmtAny(v)}</dd>
    </>
  );
}

function EventDetail({ detail }: { detail: Record<string, unknown> }) {
  const entries = Object.entries(detail).filter(([k]) => k !== 'name');
  if (!entries.length) return null;
  return (
    <div className="muted small">
      {entries.map(([k, v]) => (
        <span key={k} className="kv-inline">
          {k}: {fmtAny(v)}
        </span>
      ))}
    </div>
  );
}

function WorkflowPanel({ alert: a, onDone }: { alert: AlertDTO; onDone: () => void }) {
  const action = useResearcherAction();
  const [ackNote, setAckNote] = useState('');
  const [resNote, setResNote] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const path = `/api/alerts/${a.service}/${encodeURIComponent(a.alertId)}`;

  async function ack() {
    const r = await action.run([a.service], 'Acknowledge this alert', (code) =>
      api.post(`${path}/ack`, { note: ackNote.trim() || null }, { researcher: code }),
    );
    if (r) {
      setAckNote('');
      onDone();
    }
  }
  async function resolve() {
    if (resNote.trim().length < 3) {
      setHint('Describe how the alert was handled (at least 3 characters).');
      return;
    }
    setHint(null);
    const r = await action.run([a.service], 'Resolve this alert', (code) =>
      api.post(`${path}/resolve`, { note: resNote.trim() }, { researcher: code }),
    );
    if (r) {
      setResNote('');
      onDone();
    }
  }

  return (
    <Panel title="Workflow">
      {a.ackTs && (
        <p className="small">
          Acknowledged {fmtTs(a.ackTs)} by <strong>{a.ackName ?? 'researcher'}</strong> ({a.ackBy})
          {a.ackNote && <> — “{a.ackNote}”</>}
        </p>
      )}
      {a.resolvedTs && (
        <p className="small">
          Resolved {fmtTs(a.resolvedTs)} by <strong>{a.resolvedName ?? 'researcher'}</strong> ({a.resolvedBy}) — “
          {a.resolutionNote}”
        </p>
      )}
      {a.opState === 'unacked' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void ack();
          }}
        >
          <label className="field">
            <span>Note (optional)</span>
            <textarea rows={2} maxLength={2000} value={ackNote} onChange={(e) => setAckNote(e.target.value)} />
          </label>
          <button type="submit" className="primary" disabled={action.busy}>
            Acknowledge
          </button>
        </form>
      )}
      {a.opState === 'acked' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void resolve();
          }}
        >
          <label className="field">
            <span>How was it handled? (required)</span>
            <textarea rows={3} maxLength={2000} value={resNote} onChange={(e) => setResNote(e.target.value)} required />
          </label>
          {a.svcState === 'raised' && (
            <p className="sev-warning small">◆ The service still reports this condition as raised.</p>
          )}
          <button type="submit" className="primary" disabled={action.busy}>
            Resolve
          </button>
        </form>
      )}
      {a.opState === 'resolved' && <p className="muted">This alert is resolved. A new raise or escalation re-opens it.</p>}
      {(hint || action.error) && <ErrorBox>{hint ?? action.error}</ErrorBox>}
    </Panel>
  );
}
