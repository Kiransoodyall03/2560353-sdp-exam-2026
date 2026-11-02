// OPG main view: plant KPIs, energy flow, battery and fuel gauges, generation history and controls.
// Every control goes through the server pipeline, so a refusal reads as the controller's own reason
// (including "this researcher is not permitted to control OPG", which is shown, never hidden).
import { useEffect, useMemo, useState } from 'react';
import { Chart, type ChartSeries } from '../components/Chart';
import { CommandHistory } from '../components/CommandHistory';
import { ControlPanel } from '../components/ControlPanel';
import { EnergyFlow } from '../components/EnergyFlow';
import { FuelGauge } from '../components/FuelGauge';
import { GenerationChart } from '../components/GenerationChart';
import { SocGauge } from '../components/SocGauge';
import { Empty, ErrorBox, KpiTile, Loading, Panel, StatusPill } from '../components/ui';
import { api, errorText } from '../lib/api';
import { fmtNum, fmtTime } from '../lib/format';
import { kw, pct, useOpgLive, type OpgTrend } from '../lib/opg';

const WINDOWS = [
  { hours: 1, label: '1 h' },
  { hours: 6, label: '6 h' },
  { hours: 24, label: '24 h' },
  { hours: 168, label: '7 d' },
];

const POWER_SERIES: ChartSeries[] = [
  { label: 'Solar', color: '#f0b429', fill: 'rgba(240, 180, 41, 0.15)' },
  { label: 'Diesel', color: '#e05c5c' },
  { label: 'Load', color: '#94a3b8', dash: [4, 3] },
  { label: 'Battery (+ charging)', color: '#4cc9f0' },
];

export function OpgPage() {
  const { plant, status } = useOpgLive();
  const [hours, setHours] = useState(6);
  const [trend, setTrend] = useState<OpgTrend | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<OpgTrend>(`/api/opg/trend?hours=${hours}`)
        .then((t) => {
          if (!alive) return;
          setTrend(t);
          setTrendError(null);
        })
        .catch((err: unknown) => alive && setTrendError(errorText(err)));
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [hours]);

  const power = useMemo(() => {
    if (!trend) return null;
    const s = trend.series;
    const toKw = (v: (number | null)[]) => v.map((x) => (x == null ? null : x / 1000));
    return { ts: s.ts, values: [toKw(s.solarW), toKw(s.dieselW), toKw(s.loadW), toKw(s.batteryW)] };
  }, [trend]);

  if (!plant) return <Loading what="power grid" />;

  const d = plant.derived;
  const soc = plant.batteries.socPct;
  const reserve = plant.batteries.reservePct ?? trend?.reservePct ?? null;
  const net = d.netW;

  return (
    <div className="page">
      <h1>Power Grid</h1>
      {status !== 'open' && <div className="flag warn">◆ Live stream {status}</div>}

      <div className="kpis wide">
        <KpiTile kpi={{ label: 'Generation', value: plant.global.generationW == null ? null : Math.round(plant.global.generationW / 1000), unit: 'kW' }} />
        <KpiTile kpi={{ label: 'Load', value: plant.global.loadW == null ? null : Math.round(plant.global.loadW / 1000), unit: 'kW' }} />
        <KpiTile
          kpi={{
            label: net == null ? 'Net' : net >= 0 ? 'Net charging' : 'Net discharging',
            value: net == null ? null : Math.round(Math.abs(net) / 1000),
            unit: 'kW',
            status: net == null ? undefined : net >= 0 ? 'ok' : 'warn',
          }}
        />
        <KpiTile
          kpi={{
            label: 'Renewable share',
            value: d.renewableFraction == null ? null : Math.round(d.renewableFraction * 100),
            unit: '%',
            status: d.renewableFraction == null ? undefined : d.renewableFraction > 0.6 ? 'ok' : d.renewableFraction > 0.2 ? 'warn' : 'bad',
          }}
        />
        <KpiTile
          kpi={{
            label: 'State of charge',
            value: soc == null ? null : Math.round(soc),
            unit: '%',
            status: soc == null ? undefined : reserve != null && soc <= reserve ? 'bad' : soc < 30 ? 'warn' : 'ok',
          }}
        />
        <KpiTile
          kpi={{
            label: 'Fuel',
            value: plant.diesel.fuelPct == null ? null : Math.round(plant.diesel.fuelPct),
            unit: '%',
            status: plant.diesel.fuelPct == null ? undefined : plant.diesel.fuelPct < 2 ? 'bad' : plant.diesel.fuelPct < 25 ? 'warn' : 'ok',
          }}
        />
      </div>

      {d.shortfall && (
        <div className="flag bad">
          ◆ The load is not covered by solar, diesel and the usable battery energy ({kw(d.uncoveredW)} uncovered).
        </div>
      )}

      <div className="opg-grid">
        <Panel
          title="Energy flow"
          actions={
            <StatusPill tone={plant.daylight ? 'ok' : 'idle'}>{plant.daylight ? 'daylight' : 'night'}</StatusPill>
          }
        >
          <EnergyFlow plant={plant} />
        </Panel>
        <Panel title="Battery bank">
          <SocGauge
            socPct={soc}
            reservePct={reserve}
            storedKwh={d.storedKwh}
            usableKwh={d.usableKwh}
            timeToReserveH={d.timeToReserveH}
            powerW={plant.batteries.powerW}
            batteryKwh={plant.plant.batteryKwh}
          />
        </Panel>
        <Panel title="Diesel">
          <FuelGauge
            fuelPct={plant.diesel.fuelPct}
            litres={d.fuelLitres}
            tankL={plant.plant.fuelTankL}
            burnLph={d.burnLph}
            hoursLeftH={d.dieselHoursLeftH}
            refuels={plant.refuels}
          />
        </Panel>
      </div>

      <Panel
        title="Generation by source"
        actions={
          <div className="row gap">
            <span className="muted small">kWh delivered to the bus</span>
          </div>
        }
      >
        {trendError && <ErrorBox>{trendError}</ErrorBox>}
        {trend ? (
          <>
            <GenerationChart buckets={trend.hourly} mode="hour" />
            <p className="muted small">
              Window {fmtTime(trend.from)}–{fmtTime(trend.to)}: solar {fmtNum(trend.energy.solarKwh, 0)} kWh, battery{' '}
              {fmtNum(trend.energy.batteryOutKwh, 0)} kWh out ({fmtNum(trend.energy.batteryInKwh, 0)} in), diesel{' '}
              {fmtNum(trend.energy.dieselKwh, 0)} kWh, load {fmtNum(trend.energy.loadKwh, 0)} kWh
              {trend.energy.renewableFraction == null ? '' : ` · ${Math.round(trend.energy.renewableFraction * 100)} % renewable`}.
            </p>
            <h3>Per day</h3>
            <GenerationChart buckets={trend.daily} mode="day" />
          </>
        ) : (
          <Loading what="generation history" />
        )}
      </Panel>

      <Panel
        title="Instantaneous power"
        actions={
          <div className="row gap">
            {WINDOWS.map((w) => (
              <button key={w.hours} type="button" className={hours === w.hours ? 'primary' : undefined} onClick={() => setHours(w.hours)}>
                {w.label}
              </button>
            ))}
          </div>
        }
      >
        {power ? (
          <Chart ts={power.ts} values={power.values} series={POWER_SERIES} axes={[{ scale: 'y', label: 'kW' }]} height={220} />
        ) : (
          <Loading what="power history" />
        )}
      </Panel>

      <Panel
        title="Plant controls"
        actions={<span className="muted small">verified server-side; a refusal is shown with the controller's own reason</span>}
      >
        <div className="opg-controls">
          <ControlPanel service="opg" entities={['global']} kinds={['service']} title="Grid" showPresets />
          <ControlPanel service="opg" entities={['solar']} kinds={['array']} title="Solar array" />
          <ControlPanel service="opg" entities={['batteries']} kinds={['bank']} title="Battery bank" />
          <ControlPanel service="opg" entities={['diesel']} kinds={['generators']} title="Generators" />
        </div>
      </Panel>

      <Panel title="Command history" actions={<span className="muted small">every command is verified before it is published</span>}>
        <CommandHistory service="opg" limit={15} />
      </Panel>

      <div className="opg-grid">
        <Panel title="Solar performance">
          {plant.solar.inverterStatus == null && plant.solar.outputW == null ? (
            <Empty>No solar telemetry yet.</Empty>
          ) : (
            <dl className="facts">
              <div>
                <dt>Output</dt>
                <dd>
                  {kw(plant.solar.outputW)} of {fmtNum(plant.plant.inverterKw, 0)} kW inverter
                </dd>
              </div>
              <div>
                <dt>Irradiance</dt>
                <dd>{fmtNum(plant.solar.irradianceWm2, 0)} W/m²</dd>
              </div>
              <div>
                <dt>Expected at this irradiance</dt>
                <dd>{kw(d.solarExpectedW)}</dd>
              </div>
              <div>
                <dt>Performance ratio</dt>
                <dd>{d.solarPerformanceRatio == null ? '—' : d.solarPerformanceRatio.toFixed(3)}</dd>
              </div>
              <div>
                <dt>Headroom to the inverter</dt>
                <dd>{kw(d.solarHeadroomW)}</dd>
              </div>
              <div>
                <dt>Array state</dt>
                <dd>{plant.solar.enabled === false ? 'disabled' : 'enabled'}</dd>
              </div>
            </dl>
          )}
        </Panel>

        <Panel title="Array irradiance vs weather stations" actions={<StatusPill tone="info">LWM</StatusPill>}>
          {trend == null ? (
            <Loading what="correlation" />
          ) : trend.correlation.n < 3 ? (
            <p className="muted">
              Only {trend.correlation.n} overlapping minute{trend.correlation.n === 1 ? '' : 's'} between the plant and the weather
              stations in this window: not enough to correlate.
            </p>
          ) : (
            <>
              <dl className="facts">
                <div>
                  <dt>Pearson r</dt>
                  <dd>{trend.correlation.r == null ? '—' : trend.correlation.r.toFixed(3)}</dd>
                </div>
                <div>
                  <dt>Bias (plant − stations)</dt>
                  <dd>{trend.correlation.biasWm2 == null ? '—' : `${trend.correlation.biasWm2.toFixed(0)} W/m²`}</dd>
                </div>
                <div>
                  <dt>Mean plant / stations</dt>
                  <dd>
                    {fmtNum(trend.correlation.opgMeanWm2, 0)} / {fmtNum(trend.correlation.lwmMeanWm2, 0)} W/m²
                  </dd>
                </div>
                <div>
                  <dt>Samples paired</dt>
                  <dd>{trend.correlation.n}</dd>
                </div>
              </dl>
              <p className="muted small">
                A low r or a large bias points at a sensor or soiling problem; the performance ratio above separates that from a
                genuine drop in sunshine.
              </p>
            </>
          )}
        </Panel>
      </div>

      <Panel title="Plant" actions={<span className="muted small">ratings from the OPG specification</span>}>
        <dl className="facts wide">
          <div>
            <dt>Solar</dt>
            <dd>
              {fmtNum(plant.plant.solarKwp, 0)} kWp, {fmtNum(plant.plant.inverterKw, 0)} kW inverter
            </dd>
          </div>
          <div>
            <dt>Battery</dt>
            <dd>
              {fmtNum(plant.plant.batteryKwh, 0)} kWh, {fmtNum(plant.plant.batteryMaxKw, 0)} kW, reserve {pct(reserve, 0)}
            </dd>
          </div>
          <div>
            <dt>Diesel</dt>
            <dd>
              {plant.plant.generators} × {fmtNum(plant.plant.generatorKw, 0)} kW, {fmtNum(plant.plant.fuelTankL, 0)} L tank
            </dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{plant.global.generationPriority ?? '—'}</dd>
          </div>
          <div>
            <dt>Load shedding</dt>
            <dd>{plant.global.loadShed == null ? '—' : plant.global.loadShed ? 'on' : 'off'}</dd>
          </div>
          <div>
            <dt>Supply mode</dt>
            <dd>{plant.global.supplyMode ?? '—'}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Fuel deliveries" actions={<span className="muted small">refuel events recorded by the plant</span>}>
        {trend && trend.refuels.length === 0 ? (
          <p className="muted">No refuels in this window.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Sim time</th>
                <th>Litres</th>
                <th>Level after</th>
              </tr>
            </thead>
            <tbody>
              {(trend?.refuels ?? plant.refuels).slice(-20).reverse().map((r) => (
                <tr key={r.ts}>
                  <td className="mono">{fmtTime(r.ts)}</td>
                  <td>{r.litres == null ? '—' : fmtNum(r.litres, 0)}</td>
                  <td>{r.fuelPct == null ? '—' : `${fmtNum(r.fuelPct, 0)} %`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
