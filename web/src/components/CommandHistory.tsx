// Command history for one entity (or a whole service): what was asked, by whom (masked code),
// what the service answered, and how far it got. Reasons are always shown in plain language.
import { useMemo } from 'react';
import { explainCommandReason } from '../../../shared/commands';
import type { ServiceId } from '../../../shared/types';
import { fmtTs } from '../lib/format';
import { useCommands } from '../state/CommandsContext';
import { commandLabel, commandTone } from './CommandProgress';
import { StatusPill } from './ui';

export function CommandHistory({
  service,
  entity,
  limit = 12,
}: {
  service: ServiceId;
  entity?: string;
  limit?: number;
}) {
  const { history } = useCommands();
  const rows = useMemo(() => {
    return Object.values(history)
      .filter((c) => c.service === service && (!entity || c.entity === entity))
      .sort((a, b) => b.requestedTs - a.requestedTs)
      .slice(0, limit);
  }, [history, service, entity, limit]);

  if (rows.length === 0) return <p className="muted small">No commands yet{entity ? ` for ${entity}` : ''}.</p>;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Requested</th>
            <th>Entity</th>
            <th>Control</th>
            <th>Value</th>
            <th>State</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const reason = explainCommandReason(c.reason, { service: c.service, control: c.control });
            return (
              <tr key={c.commandId}>
                <td className="mono small">{fmtTs(c.requestedTs)}</td>
                <td className="mono small">{c.entity}</td>
                <td className="mono small">
                  {c.control}
                  <div className="muted">{c.researcher}</div>
                </td>
                <td className="mono small">{fmtValue(c.value)}</td>
                <td>
                  <StatusPill tone={commandTone(c.state)}>{commandLabel(c.state)}</StatusPill>
                  {c.progress != null && c.state !== 'completed' && (
                    <div className="progress slim" aria-label={`Progress ${Math.round(c.progress * 100)}%`}>
                      <div className="progress-bar" style={{ width: `${Math.round(c.progress * 100)}%` }} />
                    </div>
                  )}
                </td>
                <td className="small">
                  {reason && <span className={c.state === 'failed' || c.state === 'rejected' ? 'error' : ''}>{reason}</span>}
                  {c.detail && <span className="muted"> {c.detail}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function fmtValue(value: unknown): string {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (value == null) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.ra_rad === 'number' && typeof o.dec_rad === 'number') {
      return `RA ${(o.ra_rad as number).toFixed(3)} / Dec ${(o.dec_rad as number).toFixed(3)} rad`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}
