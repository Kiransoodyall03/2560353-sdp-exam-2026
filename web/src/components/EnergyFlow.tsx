// Energy flow: what is producing, what is storing and what the load draws, at this minute. The connector
// thickness and the arrow direction are the whole point, so a discharging battery reads as a source.
import type { OpgPlant } from '../lib/opg';
import { kw } from '../lib/opg';
import { SeverityBadge } from './ui';

const BUS_X = 320;
const BOX_W = 180;
const BOX_H = 58;
const LEFT_X = 20;
const LOAD_X = 420;
const Y = { solar: 24, battery: 121, diesel: 218, load: 121 };
const CENTRE = (top: number) => top + BOX_H / 2;

const COLOUR = {
  solar: 'var(--ochre)',
  battery: 'var(--sunset)',
  diesel: 'var(--dust)',
  load: 'var(--ink)',
};

/** 1 px per 60 kW, clamped so a trickle is still visible and 800 kW does not swallow the drawing. */
const widthOf = (w: number | null) => Math.max(2, Math.min(13, Math.round(Math.abs(w ?? 0) / 60_000)));

function Flow({ from, to, w, colour, id }: { from: [number, number]; to: [number, number]; w: number | null; colour: string; id: string }) {
  const active = Math.abs(w ?? 0) > 1;
  return (
    <path
      d={`M ${from[0]} ${from[1]} L ${to[0]} ${to[1]}`}
      stroke={colour}
      strokeWidth={widthOf(w)}
      opacity={active ? 0.9 : 0.18}
      markerEnd={active ? `url(#${id})` : undefined}
      strokeDasharray={active ? undefined : '4 4'}
    />
  );
}

export function EnergyFlow({ plant }: { plant: OpgPlant }) {
  const solar = plant.solar.outputW;
  const diesel = plant.diesel.outputW;
  const battery = plant.batteries.powerW; // positive = charging
  const load = plant.global.loadW;
  const charging = (battery ?? 0) > 0;
  const discharging = (battery ?? 0) < 0;
  // a load that the plant cannot cover is the one abnormal state this drawing can show
  const loadColour = plant.derived.shortfall ? 'var(--alarm-critical)' : COLOUR.load;

  return (
    <div className="flow">
      <svg viewBox="0 0 620 300" role="img" aria-label={`Solar ${kw(solar)}, diesel ${kw(diesel)}, battery ${kw(Math.abs(battery ?? 0))} ${charging ? 'charging' : 'discharging'}, load ${kw(load)}`}>
        <defs>
          {(['solar', 'battery', 'diesel', 'load'] as const).map((k) => (
            <marker key={k} id={`arrow-${k}`} markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill={k === 'load' ? loadColour : COLOUR[k]} />
            </marker>
          ))}
        </defs>

        {/* bus */}
        <line x1={BUS_X} x2={BUS_X} y1={CENTRE(Y.solar)} y2={CENTRE(Y.diesel)} stroke="var(--ink-muted)" strokeWidth={5} />
        <text x={BUS_X} y={291} className="flow-bus-label" textAnchor="middle">
          plant bus
        </text>

        {/* solar */}
        <g>
          <rect x={LEFT_X} y={Y.solar} width={BOX_W} height={BOX_H} rx={0} className="flow-box" stroke={COLOUR.solar} />
          <text x={LEFT_X + 12} y={Y.solar + 22} className="flow-name">
            Solar array
          </text>
          <text x={LEFT_X + 12} y={Y.solar + 42} className="flow-power">
            {kw(solar)}
          </text>
          <text x={LEFT_X + BOX_W - 12} y={Y.solar + 22} className="flow-tag" textAnchor="end">
            {plant.solar.enabled === false ? 'disabled' : `${Math.round(plant.solar.irradianceWm2 ?? 0)} W/m²`}
          </text>
          <Flow from={[LEFT_X + BOX_W, CENTRE(Y.solar)]} to={[BUS_X, CENTRE(Y.solar)]} w={solar} colour={COLOUR.solar} id="arrow-solar" />
        </g>

        {/* battery: the arrow points at the bus while it discharges, at the bank while it charges */}
        <g>
          <rect x={LEFT_X} y={Y.battery} width={BOX_W} height={BOX_H} rx={0} className="flow-box" stroke={COLOUR.battery} />
          <text x={LEFT_X + 12} y={Y.battery + 22} className="flow-name">
            Battery bank
          </text>
          <text x={LEFT_X + 12} y={Y.battery + 42} className="flow-power">
            {kw(Math.abs(battery ?? 0))}
          </text>
          <text x={LEFT_X + BOX_W - 12} y={Y.battery + 22} className="flow-tag" textAnchor="end">
            {charging ? 'charging' : discharging ? 'discharging' : 'idle'}
          </text>
          {charging ? (
            <Flow from={[BUS_X, CENTRE(Y.battery)]} to={[LEFT_X + BOX_W, CENTRE(Y.battery)]} w={battery} colour={COLOUR.battery} id="arrow-battery" />
          ) : (
            <Flow from={[LEFT_X + BOX_W, CENTRE(Y.battery)]} to={[BUS_X, CENTRE(Y.battery)]} w={battery} colour={COLOUR.battery} id="arrow-battery" />
          )}
        </g>

        {/* diesel */}
        <g>
          <rect x={LEFT_X} y={Y.diesel} width={BOX_W} height={BOX_H} rx={0} className="flow-box" stroke={COLOUR.diesel} />
          <text x={LEFT_X + 12} y={Y.diesel + 22} className="flow-name">
            Generators
          </text>
          <text x={LEFT_X + 12} y={Y.diesel + 42} className="flow-power">
            {kw(diesel)}
          </text>
          <text x={LEFT_X + BOX_W - 12} y={Y.diesel + 22} className="flow-tag" textAnchor="end">
            {plant.diesel.status ?? '—'}
          </text>
          <Flow from={[LEFT_X + BOX_W, CENTRE(Y.diesel)]} to={[BUS_X, CENTRE(Y.diesel)]} w={diesel} colour={COLOUR.diesel} id="arrow-diesel" />
        </g>

        {/* load */}
        <g>
          <rect x={LOAD_X} y={Y.load} width={BOX_W} height={BOX_H} rx={0} className="flow-box" stroke={loadColour} />
          <text x={LOAD_X + 12} y={Y.load + 22} className="flow-name">
            Habitat load
          </text>
          <text x={LOAD_X + 12} y={Y.load + 42} className="flow-power">
            {kw(load)}
          </text>
          <text x={LOAD_X + BOX_W - 12} y={Y.load + 22} className="flow-tag" textAnchor="end">
            {plant.global.supplyMode ?? '—'}
          </text>
          <Flow from={[BUS_X, CENTRE(Y.load)]} to={[LOAD_X, CENTRE(Y.load)]} w={load} colour={loadColour} id="arrow-load" />
        </g>
      </svg>
      {plant.derived.shortfall && <SeverityBadge severity="warning">Load not covered</SeverityBadge>}
      <p className="muted small">
        Solar {kw(solar)} · batteries {kw(Math.abs(battery ?? 0))} {charging ? 'charging' : discharging ? 'discharging' : 'idle'} · diesel{' '}
        {kw(diesel)} · load {kw(load)}. Connector width is 60 kW per pixel.
        {plant.derived.shortfall ? ' The load is not covered: the bank is at or above its reserve limit.' : ''}
      </p>
    </div>
  );
}
