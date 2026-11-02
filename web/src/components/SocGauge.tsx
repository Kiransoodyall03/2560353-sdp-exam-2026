// Battery state of charge: a flat level bar with the reserve marked, because the number that matters is
// how far the bank is from the reserve, not the percentage on its own.
import { fmtNum } from '../lib/format';
import { kw } from '../lib/opg';
import { SeverityBadge } from './ui';

const clamp = (v: number) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);

export function SocGauge({
  socPct,
  reservePct,
  storedKwh,
  usableKwh,
  timeToReserveH,
  powerW,
  batteryKwh,
}: {
  socPct: number | null;
  reservePct: number | null;
  storedKwh: number | null;
  usableKwh: number | null;
  timeToReserveH: number | null;
  powerW: number | null;
  batteryKwh: number;
}) {
  const soc = clamp(socPct ?? 0);
  const reserve = clamp(reservePct ?? 0);
  const belowReserve = socPct !== null && socPct <= reserve;
  const nearReserve = !belowReserve && socPct !== null && socPct < reserve + 10;

  return (
    <div className={`gauge${belowReserve ? ' limit-low' : ''}`}>
      <div className="reading-head">
        <span className="arl-label">State of charge</span>
        {belowReserve && <SeverityBadge severity="critical">Below reserve</SeverityBadge>}
        {nearReserve && <SeverityBadge severity="warning">Near reserve</SeverityBadge>}
      </div>
      <div className="arl-reading">
        {fmtNum(socPct, 1)}
        {socPct !== null && <small>%</small>}
      </div>
      <div
        className="arl-limit gauge-track"
        role="img"
        aria-label={`State of charge ${fmtNum(socPct, 1)} %, reserve ${fmtNum(reservePct, 0)} %`}
        title={`Reserve ${fmtNum(reservePct, 0)} %`}
      >
        <span className="arl-limit__fill" style={{ width: `${soc}%` }} />
        {reservePct !== null && <span className="arl-limit__mark" style={{ left: `calc(${reserve}% - 1px)` }} />}
      </div>
      <p className="reading-cause">
        {storedKwh === null ? 'Stored energy unknown' : `${fmtNum(storedKwh, 0)} of ${fmtNum(batteryKwh, 0)} kWh stored`}
        {reservePct === null ? '' : ` · reserve ${fmtNum(reserve, 0)} %`}
      </p>
      <dl className="gauge-facts">
        <div>
          <dt>Usable above reserve</dt>
          <dd>{usableKwh === null ? '—' : `${fmtNum(usableKwh, 0)} kWh`}</dd>
        </div>
        <div>
          <dt>To reserve at this rate</dt>
          <dd>
            {timeToReserveH === null
              ? powerW !== null && powerW > 0
                ? 'Charging'
                : '—'
              : `${fmtNum(timeToReserveH, 1)} h`}
          </dd>
        </div>
        <div>
          <dt>Bank power</dt>
          <dd>
            {powerW === null
              ? '—'
              : `${kw(Math.abs(powerW))} ${powerW > 0 ? 'charging' : powerW < 0 ? 'discharging' : 'idle'}`}
          </dd>
        </div>
      </dl>
    </div>
  );
}
