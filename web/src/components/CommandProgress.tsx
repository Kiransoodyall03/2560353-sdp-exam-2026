// One command's progress: state pill, bar, and the plain-language reason/detail the service gave.
// Detail that looks like a scan id becomes a link, so "start scan" immediately leads to its image.
import { Link } from 'react-router-dom';
import { explainCommandReason } from '../../../shared/commands';
import type { CommandDTO } from '../../../shared/types';
import { fmtTs } from '../lib/format';
import { StatusPill, type Tone } from './ui';

const TONE: Record<string, Tone> = {
  pending: 'idle',
  accepted: 'info',
  in_progress: 'info',
  completed: 'ok',
  failed: 'bad',
  rejected: 'bad',
};

const LABEL: Record<string, string> = {
  pending: 'pending',
  accepted: 'accepted',
  in_progress: 'in progress',
  completed: 'completed',
  failed: 'failed',
  rejected: 'rejected',
};

export function commandTone(state: string): Tone {
  return TONE[state] ?? 'idle';
}

export function commandLabel(state: string): string {
  return LABEL[state] ?? state;
}

/** Every scan id mentioned in a detail string, so "completed (scan-0007)" links through. */
export function scanIdsIn(detail: string | null): string[] {
  return detail ? [...new Set(detail.match(/scan-[A-Za-z0-9]+/g) ?? [])] : [];
}

export function CommandProgress({ command, showTs = true }: { command: CommandDTO | null; showTs?: boolean }) {
  if (!command) return null;
  const reason = explainCommandReason(command.reason, { service: command.service, control: command.control });
  const scans = scanIdsIn(command.detail);
  const pct = command.progress == null ? null : Math.round(command.progress * 100);
  return (
    <div className="cmd-progress">
      <div className="row gap">
        <StatusPill tone={commandTone(command.state)}>{commandLabel(command.state)}</StatusPill>
        <span className="mono small">{command.control}</span>
        {showTs && <span className="muted small">{fmtTs(command.requestedTs)}</span>}
      </div>
      {pct != null && command.state !== 'completed' && (
        <div className="progress" aria-label={`Progress ${pct}%`}>
          <div className="progress-bar" style={{ width: `${pct}%` }} />
          <span>{pct}%</span>
        </div>
      )}
      {reason && (
        <p className={command.state === 'failed' || command.state === 'rejected' ? 'error small' : 'small'} role="status">
          {reason}
        </p>
      )}
      {command.detail && !reason && <p className="muted small">{command.detail}</p>}
      {command.detail && reason && <p className="muted small">{command.detail}</p>}
      {scans.length > 0 && (
        <p className="small">
          {scans.map((id) => (
            <Link key={id} to={`/rta/scans/${id}`} className="mono">
              Open {id} →
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}
