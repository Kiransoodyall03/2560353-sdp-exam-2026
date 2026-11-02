// Small shared presentational pieces. Severity and status always carry an icon and a word, never colour alone.
import type { ReactNode } from 'react';
import type { KpiDTO, Severity } from '../../../shared/types';

const SEV_TEXT: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' };

/** 12 px severity mark: triangle = critical, diamond = warning, circle = info. */
function SevIcon({ severity }: { severity: Severity }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {severity === 'critical' && (
        <>
          <path d="M6 1.2 11.2 10.6H.8z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M6 4.3v2.5M6 8.4v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      )}
      {severity === 'warning' && (
        <path d="M6 .9 11.1 6 6 11.1.9 6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      )}
      {severity === 'info' && <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />}
    </svg>
  );
}

export function SeverityBadge({
  severity,
  compact = false,
  unacked = false,
  children,
}: {
  severity: Severity;
  /** Icon only; the word stays available to assistive technology. */
  compact?: boolean;
  /** Unacknowledged treatment: blinks, or is underlined when motion is reduced. */
  unacked?: boolean;
  children?: ReactNode;
}) {
  const label = SEV_TEXT[severity];
  return (
    <span
      className={`arl-sev arl-sev--${severity}${unacked ? ' arl-sev--unacked' : ''}`}
      title={compact ? label : undefined}
    >
      <SevIcon severity={severity} />
      {compact ? <span className="sr-only">{label}</span> : <span>{children ?? label}</span>}
    </span>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'info';

/** Same marks as severity, plus a filled square for normal and a hollow one for unknown. */
function ToneMark({ tone }: { tone: Tone }) {
  if (tone === 'warn') return <SevIcon severity="warning" />;
  if (tone === 'bad') return <SevIcon severity="critical" />;
  if (tone === 'info') return <SevIcon severity="info" />;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect
        x="2.5"
        y="2.5"
        width="7"
        height="7"
        fill={tone === 'ok' ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

export function StatusPill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill tone-${tone}`} title={title}>
      <ToneMark tone={tone} />
      {children}
    </span>
  );
}

export interface ReadingLimit {
  /** Where the limit sits on the bar's 0..1 axis. */
  at: number;
  /** What the mark means, e.g. "Stow limit 15 m/s". */
  label: string;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * One headline reading: label, value with its unit, an optional limit bar and a one-sentence cause.
 * A page shows at most four of these; everything else belongs in a table.
 */
export function KpiTile({
  kpi,
  cause,
  fill,
  limit,
  lastSeen,
}: {
  kpi: KpiDTO;
  cause?: ReactNode;
  /** Share of the bar the reading currently occupies, 0..1. */
  fill?: number;
  limit?: ReadingLimit;
  /** When set, the reading is stale or its source is offline and this is the last good time. */
  lastSeen?: string;
}) {
  const sev: Severity | null = kpi.status === 'bad' ? 'critical' : kpi.status === 'warn' ? 'warning' : null;
  return (
    <div className="reading">
      <div className="reading-head">
        <span className="arl-label">{kpi.label}</span>
        {sev && <SeverityBadge severity={sev} compact />}
      </div>
      <div className="arl-reading">
        {kpi.value ?? '—'}
        {kpi.unit && kpi.value != null && <small>{kpi.unit}</small>}
      </div>
      {limit && (
        <div className="arl-limit" role="img" aria-label={limit.label} title={limit.label}>
          {fill != null && <span className="arl-limit__fill" style={{ width: `${clamp01(fill) * 100}%` }} />}
          <span className="arl-limit__mark" style={{ left: `calc(${clamp01(limit.at) * 100}% - 1px)` }} />
        </div>
      )}
      {cause && <p className="reading-cause">{cause}</p>}
      {lastSeen !== undefined && <div className="arl-label reading-stale">Last seen {lastSeen}</div>}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`arl-panel${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <header className="panel-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="error-box" role="alert">
      <SeverityBadge severity="critical" compact />
      <span>{children}</span>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="empty">Loading {what}…</div>;
}
