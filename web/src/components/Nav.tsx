import { NavLink } from 'react-router-dom';
import type { ServiceId } from '../../../shared/types';
import { fmtTs } from '../lib/format';
import { useLive } from '../lib/live';
import { useResearcher } from '../lib/researcher';

const LINKS: { to: string; label: string; svc?: ServiceId; end?: boolean }[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/rta', label: 'Radio Telescope', svc: 'rta' },
  { to: '/lwm', label: 'Weather', svc: 'lwm' },
  { to: '/opg', label: 'Power Grid', svc: 'opg' },
  { to: '/alerts', label: 'Annunciator' },
  { to: '/replay', label: 'Replay' },
];

export function Nav() {
  const { overview, summary, simNow } = useLive();
  const { name, code, signOut } = useResearcher();
  return (
    <aside className="nav" aria-label="Main">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          ◎
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
            const online = h?.online;
            return (
              <li key={l.to}>
                <NavLink to={l.to} end={l.end ?? false}>
                  {l.svc && (
                    <span
                      className={`dot ${online === true ? 'tone-ok' : online === false ? 'tone-bad' : 'tone-idle'}`}
                      title={online === true ? 'online' : online === false ? 'offline' : 'unknown'}
                      aria-label={online === true ? 'online' : online === false ? 'offline' : 'state unknown'}
                    />
                  )}
                  <span className="nav-label">{l.label}</span>
                  {unacked > 0 && <span className="nav-badge">{unacked}</span>}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="nav-foot">
        <div className="muted small">Sim time (SAST)</div>
        <div className="mono">{fmtTs(simNow)}</div>
        <div className="researcher">
          {code ? (
            <>
              <span title="Verified researcher">◉ {name ?? 'researcher'}</span>
              <button className="link" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <span className="muted small">No researcher signed in</span>
          )}
        </div>
      </div>
    </aside>
  );
}

function sumUnacked(s: { unacked: Record<string, number> } | null): number {
  return s ? Object.values(s.unacked).reduce((a, b) => a + b, 0) : 0;
}
