// Annunciator: open alerts grouped by severity → service, unacked blink, filters, bulk ack/resolve.
// Live list comes from the `alerts` SSE stream; resolved history is fetched on demand.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AlertDTO, AlertService, Severity } from '../../../shared/types';
import { SEVERITY_RANK } from '../../../shared/types';
import { alertHref, EntityLink } from '../components/EntityLink';
import { ErrorBox, SeverityBadge } from '../components/ui';
import { VirtualList } from '../components/VirtualList';
import { useResearcherAction } from '../lib/actions';
import { api, errorText } from '../lib/api';
import { fmtNum, fmtTs } from '../lib/format';
import { OP_TEXT, SERVICE_TEXT, SEVERITY_TEXT, SVC_TEXT } from '../lib/labels';
import { useLive } from '../lib/live';

const SEVERITIES: Severity[] = ['critical', 'warning', 'info'];
const SERVICES: AlertService[] = ['rta', 'lwm', 'opg', 'platform'];
const ROW_H = 40;

type Row =
  | { kind: 'sev'; severity: Severity; count: number; unacked: number }
  | { kind: 'svc'; severity: Severity; service: AlertService; count: number; unacked: number }
  | { kind: 'alert'; alert: AlertDTO };

export function AnnunciatorPage() {
  const live = useLive();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const fService = params.get('service') ?? '';
  const fSeverity = params.get('severity') ?? '';
  const fOp = params.get('op') ?? '';
  const fSvc = params.get('svc') ?? '';
  const fText = params.get('q') ?? '';
  const history = params.get('history') === '1' || fOp === 'resolved';
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const action = useResearcherAction();

  // resolved history is not on the live stream; reload when the summary moves
  const [historyItems, setHistoryItems] = useState<AlertDTO[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const summaryKey = JSON.stringify(live.summary);
  useEffect(() => {
    if (!history) return;
    const ctl = new AbortController();
    const q = new URLSearchParams({ includeResolved: '1', limit: '5000' });
    if (fService) q.set('service', fService);
    if (fOp) q.set('op', fOp);
    const t = setTimeout(() => {
      api
        .get<{ alerts: AlertDTO[] }>(`/api/alerts?${q}`, { signal: ctl.signal })
        .then((r) => {
          setHistoryItems(r.alerts);
          setHistoryError(null);
        })
        .catch((err) => {
          if ((err as Error).name !== 'AbortError') setHistoryError(errorText(err));
        });
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [history, fService, fOp, summaryKey]);

  const source = history ? (historyItems ?? []) : Object.values(live.alerts);
  const filtered = useMemo(() => {
    const text = fText.trim().toLowerCase();
    return source.filter(
      (a) =>
        (!fService || a.service === fService) &&
        (!fSeverity || a.severity === fSeverity) &&
        (!fOp || a.opState === fOp) &&
        (!fSvc || a.svcState === fSvc) &&
        (!text ||
          a.type.toLowerCase().includes(text) ||
          a.message.toLowerCase().includes(text) ||
          (a.entity ?? '').toLowerCase().includes(text) ||
          a.alertId.toLowerCase().includes(text)),
    );
  }, [source, fService, fSeverity, fOp, fSvc, fText]);

  const rows = useMemo(() => buildRows(filtered, collapsed), [filtered, collapsed]);

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const toggleGroup = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  const toggleSel = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const byKey = new Map(filtered.map((a) => [a.key, a]));
  const sel = [...selected].map((k) => byKey.get(k)).filter((a): a is AlertDTO => !!a);
  const canAck = sel.filter((a) => a.opState === 'unacked');
  const canResolve = sel.filter((a) => a.opState === 'acked');

  async function bulk(kind: 'ack' | 'resolve', list: AlertDTO[]) {
    setResult(null);
    if (kind === 'resolve' && note.trim().length < 3) {
      setResult('Describe how the alerts were handled (at least 3 characters) before resolving.');
      return;
    }
    const purpose = kind === 'ack' ? `Acknowledge ${list.length} alert(s)` : `Resolve ${list.length} alert(s)`;
    const r = await action.run(
      list.map((a) => a.service),
      purpose,
      (code) =>
        api.post<{ results: { key: string; ok: boolean; error: string | null }[]; done: number }>(
          '/api/alerts/bulk',
          { action: kind, keys: list.map((a) => a.key), note: note.trim() || null },
          { researcher: code },
        ),
    );
    if (!r) return;
    const failed = r.results.filter((x) => !x.ok);
    setResult(`${r.done} of ${list.length} ${kind === 'ack' ? 'acknowledged' : 'resolved'}${failed.length ? ` · ${failed.length} skipped (${[...new Set(failed.map((f) => f.error))].join(', ')})` : ''}`);
    setSelected(new Set());
    if (kind === 'resolve') setNote('');
  }

  return (
    <div className="page page-fill">
      <h1>Annunciator</h1>
      <div className="filters" role="search">
        <select aria-label="Service" value={fService} onChange={(e) => setFilter('service', e.target.value)}>
          <option value="">All services</option>
          {SERVICES.map((s) => (
            <option key={s} value={s}>
              {SERVICE_TEXT[s]}
            </option>
          ))}
        </select>
        <select aria-label="Severity" value={fSeverity} onChange={(e) => setFilter('severity', e.target.value)}>
          <option value="">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_TEXT[s]}
            </option>
          ))}
        </select>
        <select aria-label="Workflow state" value={fOp} onChange={(e) => setFilter('op', e.target.value)}>
          <option value="">Unacked + acked</option>
          <option value="unacked">Unacknowledged</option>
          <option value="acked">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
        <select aria-label="Condition" value={fSvc} onChange={(e) => setFilter('svc', e.target.value)}>
          <option value="">Raised + cleared</option>
          <option value="raised">Still raised</option>
          <option value="cleared">Cleared by service</option>
        </select>
        <input
          type="search"
          placeholder="Filter text, entity, id…"
          aria-label="Text filter"
          value={fText}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={history} onChange={(e) => setFilter('history', e.target.checked ? '1' : '')} />
          include resolved
        </label>
        <span className="muted small">
          {filtered.length.toLocaleString()} shown{history && historyItems === null ? ' (loading…)' : ''}
        </span>
      </div>

      <div className="bulkbar">
        <span>{sel.length} selected</span>
        <button
          type="button"
          className="arl-btn"
          onClick={() => setSelected(new Set(filtered.filter((a) => a.opState !== 'resolved').map((a) => a.key)))}
        >
          Select all shown
        </button>
        <button type="button" className="arl-btn" onClick={() => setSelected(new Set())} disabled={!sel.length}>
          Clear selection
        </button>
        <input
          className="grow"
          placeholder="Note (optional to acknowledge, required to resolve)"
          aria-label="Note for bulk action"
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          className="arl-btn arl-btn--primary"
          disabled={!canAck.length || action.busy}
          onClick={() => void bulk('ack', canAck)}
        >
          Acknowledge {canAck.length || ''}
        </button>
        <button type="button" className="arl-btn" disabled={!canResolve.length || action.busy} onClick={() => void bulk('resolve', canResolve)}>
          Resolve {canResolve.length || ''}
        </button>
      </div>
      {(action.error || result) && <div className={action.error ? 'error-box' : 'note-box'}>{action.error ?? result}</div>}
      {historyError && <ErrorBox>Could not load resolved alerts: {historyError}</ErrorBox>}

      <div className="ann-table">
        <div className="ann-head ann-grid" aria-hidden="true">
          <span />
          <span>Severity</span>
          <span>Type</span>
          <span>Entity</span>
          <span>Value / limit</span>
          <span>Message</span>
          <span>Raised</span>
          <span>State</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">{live.alertsStatus === 'open' ? 'No alerts match.' : 'Connecting to the alert stream…'}</div>
        ) : (
          <VirtualList
            items={rows}
            rowHeight={ROW_H}
            ariaLabel="Alerts"
            className="ann-list"
            render={(r) => renderRow(r)}
          />
        )}
      </div>
    </div>
  );

  function renderRow(r: Row) {
    if (r.kind === 'sev') {
      const g = r.severity;
      return (
        <button type="button" className={`group-head sev-bg-${r.severity}`} onClick={() => toggleGroup(g)} aria-expanded={!collapsed.has(g)}>
          <span aria-hidden="true">{collapsed.has(g) ? '▸' : '▾'}</span>
          <SeverityBadge severity={r.severity} />
          <span>
            {r.count} alerts · {r.unacked} unacknowledged
          </span>
        </button>
      );
    }
    if (r.kind === 'svc') {
      const g = `${r.severity}/${r.service}`;
      return (
        <button type="button" className="group-sub" onClick={() => toggleGroup(g)} aria-expanded={!collapsed.has(g)}>
          <span aria-hidden="true">{collapsed.has(g) ? '▸' : '▾'}</span>
          <strong>{SERVICE_TEXT[r.service]}</strong>
          <span className="muted">
            {r.count} · {r.unacked} unacknowledged
          </span>
        </button>
      );
    }
    const a = r.alert;
    return (
      <div
        className={`ann-row ann-grid ${a.opState === 'unacked' ? `unacked unacked-${a.severity}` : ''} ${a.svcState === 'cleared' ? 'cleared' : ''}`}
        role="listitem"
        onClick={() => nav(alertHref(a))}
        onKeyDown={(e) => e.key === 'Enter' && nav(alertHref(a))}
        tabIndex={0}
      >
        <span onClick={(e) => e.stopPropagation()}>
          {a.opState !== 'resolved' && (
            <input
              type="checkbox"
              aria-label={`Select ${a.alertId}`}
              checked={selected.has(a.key)}
              onChange={() => toggleSel(a.key)}
            />
          )}
        </span>
        <span>
          <SeverityBadge severity={a.severity} compact />
          {a.maxSeverity !== a.severity && (
            <span className="muted small" title="Highest severity this alert reached">
              {' '}
              peak {SEVERITY_TEXT[a.maxSeverity]}
            </span>
          )}
        </span>
        <span className="ellipsis" title={a.type}>
          {a.service === 'platform' ? 'platform · ' : ''}
          {a.type}
          {a.placeholder && (
            <span className="tag" title="Raised before capture; details pending">
              pre-capture
            </span>
          )}
        </span>
        <span className="ellipsis">
          <EntityLink alert={a} />
        </span>
        <span className="mono small ellipsis" title={valueVsLimit(a)}>
          {valueVsLimit(a)}
        </span>
        <span className="ellipsis" title={a.message}>
          {a.message}
        </span>
        <span className="mono small">{fmtTs(a.raisedTs)}</span>
        <span className="state-cell small">
          <span className={a.svcState === 'raised' ? 'sev-warning' : 'muted'}>{SVC_TEXT[a.svcState] ?? a.svcState}</span>
          <span className={`op op-${a.opState}`}>
            {OP_TEXT[a.opState] ?? a.opState}
            {a.ackName && a.opState !== 'unacked' && <span className="muted"> · {a.ackName}</span>}
          </span>
        </span>
      </div>
    );
  }
}

export function valueVsLimit(a: Pick<AlertDTO, 'value' | 'limit' | 'unit'>): string {
  if (a.value == null && a.limit == null) return '—';
  const u = a.unit ? ` ${a.unit}` : '';
  return `${fmtNum(a.value, 2)}${u} / ${fmtNum(a.limit, 2)}${u}`;
}

function buildRows(alerts: AlertDTO[], collapsed: Set<string>): Row[] {
  const sorted = [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      SERVICES.indexOf(a.service) - SERVICES.indexOf(b.service) ||
      opRank(a) - opRank(b) ||
      (b.raisedTs ?? 0) - (a.raisedTs ?? 0),
  );
  const rows: Row[] = [];
  for (const sev of SEVERITIES) {
    const inSev = sorted.filter((a) => a.severity === sev);
    if (!inSev.length) continue;
    rows.push({ kind: 'sev', severity: sev, count: inSev.length, unacked: inSev.filter((a) => a.opState === 'unacked').length });
    if (collapsed.has(sev)) continue;
    for (const svc of SERVICES) {
      const inSvc = inSev.filter((a) => a.service === svc);
      if (!inSvc.length) continue;
      rows.push({
        kind: 'svc',
        severity: sev,
        service: svc,
        count: inSvc.length,
        unacked: inSvc.filter((a) => a.opState === 'unacked').length,
      });
      if (collapsed.has(`${sev}/${svc}`)) continue;
      for (const a of inSvc) rows.push({ kind: 'alert', alert: a });
    }
  }
  return rows;
}

const opRank = (a: AlertDTO) => (a.opState === 'unacked' ? 0 : a.opState === 'acked' ? 1 : 2);
