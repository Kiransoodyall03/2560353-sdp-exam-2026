// Battery state of charge: a 240° arc with the reserve drawn as a radial line, because the number that
// matters is how far the bank is from the reserve, not the percentage on its own.
import { fmtNum } from '../lib/format';
import { kw } from '../lib/opg';

const CX = 120;
const CY = 120;
const R = 88;
const SWEEP = 240;
const START = -120; // degrees from straight up; the arc runs clockwise as the value rises
const STEP = 4;

const at = (percent: number) => START + (SWEEP * clamp(percent, 0, 100)) / 100;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function point(deg: number, rad = R): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + rad * Math.cos(a), CY + rad * Math.sin(a)];
}

function arc(fromDeg: number, toDeg: number, rad = R): string {
  const [x1, y1] = point(fromDeg, rad);
  const [x2, y2] = point(toDeg, rad);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${rad} ${rad} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

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
  const soc = socPct ?? 0;
  const reserve = reservePct ?? 0;
  const belowReserve = socPct !== null && socPct <= reserve;
  const tone = socPct === null ? 'idle' : belowReserve ? 'bad' : socPct < reserve + 10 ? 'warn' : 'ok';
  const colour = tone === 'bad' ? '#e05c5c' : tone === 'warn' ? '#e0a33c' : '#4cc9f0';
  const [rx1, ry1] = point(at(reserve), R - 16);
  const [rx2, ry2] = point(at(reserve), R + 10);
  const [lx, ly] = point(at(reserve), R + 26);
  const ticks = Array.from({ length: 100 / STEP + 1 }, (_, i) => i * STEP);

  return (
    <div className={`gauge tone-${tone}`}>
      <svg viewBox="0 0 240 210" role="img" aria-label={`Battery at ${fmtNum(socPct, 1)} %, reserve ${fmtNum(reservePct, 0)} %`}>
        <path d={arc(START, START + SWEEP)} stroke="#232a34" strokeWidth={14} fill="none" strokeLinecap="round" />
        {/* the band the plant may use: reserve → 100 % */}
        {reservePct !== null && <path d={arc(at(reserve), at(100))} stroke="#1d4a55" strokeWidth={14} fill="none" />}
        {socPct !== null && soc > 0 && (
          <path d={arc(START, at(soc))} stroke={colour} strokeWidth={14} fill="none" strokeLinecap="butt" />
        )}
        {ticks.map((t) => {
          const [x1, y1] = point(at(t), R - 22);
          const [x2, y2] = point(at(t), t % 25 === 0 ? R - 14 : R - 18);
          return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#3a4553" strokeWidth={1} />;
        })}
        {reservePct !== null && (
          <>
            <line x1={rx1} y1={ry1} x2={rx2} y2={ry2} stroke="#e0a33c" strokeWidth={2} />
            <text x={lx} y={ly} className="gauge-tick-label" textAnchor="middle">
              {fmtNum(reserve, 0)} %
            </text>
          </>
        )}
        <text x={CX} y={CY + 4} className="gauge-value" textAnchor="middle">
          {fmtNum(socPct, 1)}
          <tspan className="gauge-unit"> %</tspan>
        </text>
        <text x={CX} y={CY + 26} className="gauge-sub" textAnchor="middle">
          {storedKwh === null ? '—' : `${fmtNum(storedKwh, 0)} / ${fmtNum(batteryKwh, 0)} kWh`}
        </text>
      </svg>
      <dl className="gauge-facts">
        <div>
          <dt>Usable above reserve</dt>
          <dd>{usableKwh === null ? '—' : `${fmtNum(usableKwh, 0)} kWh`}</dd>
        </div>
        <div>
          <dt>To reserve at this rate</dt>
          <dd>{timeToReserveH === null ? (powerW !== null && powerW > 0 ? 'charging' : '—') : `${fmtNum(timeToReserveH, 1)} h`}</dd>
        </div>
        <div>
          <dt>Bank power</dt>
          <dd>
            {powerW === null ? '—' : `${kw(Math.abs(powerW))} ${powerW > 0 ? 'charging' : powerW < 0 ? 'discharging' : 'idle'}`}
          </dd>
        </div>
      </dl>
    </div>
  );
}
