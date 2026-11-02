// Where an alert's entity lives in the UI.
import { Link } from 'react-router-dom';
import type { AlertDTO } from '../../../shared/types';

export function entityHref(service: string, entity: string | null): string | null {
  if (!entity) return null;
  if (service === 'rta') {
    if (/^dish-\d{3}$/.test(entity)) return `/rta/dish/${entity}`;
    if (entity === 'global') return '/rta';
    return `/rta?subarray=${encodeURIComponent(entity)}`;
  }
  if (service === 'lwm' || service === 'opg') return `/${service}`;
  return null;
}

export function alertHref(a: Pick<AlertDTO, 'service' | 'alertId'>): string {
  return `/alerts/${a.service}/${encodeURIComponent(a.alertId)}`;
}

export function EntityLink({ alert }: { alert: AlertDTO }) {
  const subject = alert.service === 'platform' ? String(alert.metadata['subject'] ?? '') : alert.service;
  const href = entityHref(subject, alert.entity);
  if (!alert.entity) return <span className="muted">—</span>;
  if (!href) return <span className="mono">{alert.entity}</span>;
  return (
    <Link to={href} className="mono" onClick={(e) => e.stopPropagation()}>
      {alert.entity}
    </Link>
  );
}
