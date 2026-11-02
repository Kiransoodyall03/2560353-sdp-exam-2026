// Small shared presentational pieces. Severity and status always carry an icon + text, never colour alone.
import type { ReactNode } from 'react';
import type { KpiDTO, Severity } from '../../../shared/types';

const SEV_ICON: Record<Severity, string> = { critical: '▲', warning: '◆', info: '●' };
const SEV_TEXT: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' };

export function SeverityBadge({ severity, compact = false }: { severity: Severity; compact?: boolean }) {
  return (
    <span className={`sev sev-${severity}`} title={SEV_TEXT[severity]}>
      <span aria-hidden="true">{SEV_ICON[severity]}</span>
      {compact ? <span className="sr-only">{SEV_TEXT[severity]}</span> : <span>{SEV_TEXT[severity]}</span>}
    </span>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'info';
const TONE_ICON: Record<Tone, string> = { ok: '●', warn: '◆', bad: '▲', idle: '○', info: '●' };

export function StatusPill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill tone-${tone}`} title={title}>
      <span aria-hidden="true">{TONE_ICON[tone]}</span>
      {children}
    </span>
  );
}

export function KpiTile({ kpi }: { kpi: KpiDTO }) {
  const tone: Tone = kpi.status === 'bad' ? 'bad' : kpi.status === 'warn' ? 'warn' : kpi.status === 'ok' ? 'ok' : 'idle';
  return (
    <div className={`kpi tone-${tone}`}>
      <div className="kpi-label">{kpi.label}</div>
      <div className="kpi-value">
        {kpi.value ?? '—'}
        {kpi.unit && kpi.value != null && <span className="unit"> {kpi.unit}</span>}
      </div>
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
    <section className={`panel ${className ?? ''}`}>
      {(title || actions) && (
        <header className="panel-head">
          {title && <h2>{title}</h2>}
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
      {children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="empty">Loading {what}…</div>;
}
