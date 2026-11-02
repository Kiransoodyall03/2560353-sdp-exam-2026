import { NavLink } from 'react-router-dom';
import type { ServiceId } from '../../../shared/types';
import { useLive } from '../lib/live';
import { useResearcher } from '../lib/researcher';
import { useTheme } from '../lib/theme';
import { SeverityBadge } from './ui';

const LINKS: { to: string; label: string; svc?: ServiceId; end?: boolean }[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/rta', label: 'Radio telescope', svc: 'rta' },
  { to: '/lwm', label: 'Weather', svc: 'lwm' },
  { to: '/opg', label: 'Power', svc: 'opg' },
  { to: '/alerts', label: 'Annunciator' },
  { to: '/replay', label: 'Replay' },
];

export function Nav() {
  const { overview, summary } = useLive();
  const { name, code, signOut } = useResearcher();
  const { theme, toggle } = useTheme();

  return (
    <aside className="nav" aria-label="Main">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          AR
        </span>
        <div>
          <div className="brand-title">ARL Control</div>
          <div className="brand-sub">Mars research outpost</div>
        </div>
      </div>
      <nav>
        <ul>
          {LINKS.map((l) => {
            const h = l.svc ? overview?.services.find((s) => s.health.service === l.svc)?.health : undefined;
            const unacked = l.svc ? summary?.byService[l.svc]?.unacked ?? 0 : l.to === '/alerts' ? sumUnacked(summary) : 0;
            const offline = h?.online === false;
            return (
              <li key={l.to}>
                <NavLink to={l.to} end={l.end ?? false}>
                  <span className="nav-mark" aria-hidden="true" />
                  <span className="nav-label">{l.label}</span>
                  {offline && (
                    <span title="Service offline">
                      <SeverityBadge severity="critical" compact />
                    </span>
                  )}
                  {unacked > 0 && (
                    <span className="nav-badge" title={`${unacked} unacknowledged`}>
                      {unacked}
                    </span>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="nav-foot">
        <div className="researcher">
          {code ? (
            <>
              <span title="Verified researcher">{name ?? 'Researcher'}</span>
              <button type="button" className="link" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <span className="muted small">No researcher signed in</span>
          )}
        </div>
        <button
          type="button"
          className="nav-theme"
          onClick={toggle}
          title={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
      </div>
    </aside>
  );
}

function sumUnacked(s: { unacked: Record<string, number> } | null): number {
  return s ? Object.values(s.unacked).reduce((a, b) => a + b, 0) : 0;
}
