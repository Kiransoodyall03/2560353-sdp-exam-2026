// Dish drill-down: live state from the rta stream + telemetry history (temperature vs irradiance, power,
// pointing, SNR) and state changes.
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { DishDTO } from '../../../shared/types';
import { alignSeries, Chart } from '../components/Chart';
import { CommandHistory } from '../components/CommandHistory';
import { ControlPanel } from '../components/ControlPanel';
import { alertHref } from '../components/EntityLink';
import { Empty, ErrorBox, Loading, Panel, SeverityBadge, StatusPill, type Tone } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useThemeColors } from '../lib/colors';
import { deg, fmtAny, fmtNum, fmtTs, kToC } from '../lib/format';
import { useLive } from '../lib/live';
import { useRtaLive } from '../lib/rta';

interface History {
  dish: string;
  from: number;
  to: number;
  series: {
    ts: number[];
    stream: string[];
    temperature_k: (number | null)[];
    power_w: (number | null)[];
    system_temperature_k: (number | null)[];
    elevation_rad: (number | null)[];
    azimuth_rad: (number | null)[];
    snr_db: (number | null)[];
  };
  irradiance: { ts: number[]; wm2: number[] };
  states: { item: string; ts: number; value: unknown }[];
}

const TONE: Record<DishDTO['status'], Tone> = {
  ok: 'ok',
  scanning: 'ok',
  stowed: 'warn',
  disabled: 'idle',
  fault: 'bad',
  warning: 'warn',
  offline: 'bad',
  unknown: 'idle',
};

const STATUS_TEXT: Record<DishDTO['status'], string> = {
  ok: 'In service',
  scanning: 'Scanning',
  stowed: 'Stowed',
  disabled: 'Disabled',
  fault: 'Fault',
  warning: 'Warning',
  offline: 'Offline',
  unknown: 'Unknown',
};

export function DishDetailPage() {
  const { id = '' } = useParams();
  const rta = useRtaLive();
  const live = useLive();
  const colours = useThemeColors();
  const d = rta.dishById.get(id);
  const [hours, setHours] = useState(6);
  const [hist, setHist] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<History>(`/api/rta/dishes/${encodeURIComponent(id)}/history?hours=${hours}`)
        .then((h) => alive && (setHist(h), setError(null)))
        .catch((err) => alive && setError(errorText(err)));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, hours]);

  const charts = useMemo(() => {
    if (!hist) return null;
    const s = hist.series;
    const temp = alignSeries([
      { ts: s.ts, v: s.temperature_k.map((k) => kToC(k)) },
      { ts: hist.irradiance.ts, v: hist.irradiance.wm2 },
    ]);
    const power = alignSeries([
      { ts: s.ts, v: s.power_w },
      { ts: s.ts, v: s.system_temperature_k },
    ]);
    const pointing = alignSeries([
      { ts: s.ts, v: s.elevation_rad.map(deg) },
      { ts: s.ts, v: s.azimuth_rad.map(deg) },
    ]);
    const snr = alignSeries([{ ts: s.ts, v: s.snr_db }]);
    return { temp, power, pointing, snr, hasSnr: s.snr_db.some((v) => v != null) };
  }, [hist]);

  const alerts = Object.values(live.alerts).filter((a) => a.service === 'rta' && a.entity === id);

  if (!d && rta.status !== 'open') return <Loading what={id} />;
  if (!d) return <Empty>No dish “{id}”.</Empty>;

  return (
    <div className="page">
      <p>
        <Link to="/rta">← Radio telescope</Link>
      </p>
      <h1 className="row gap">
        <span className="arl-num">{d.id}</span>
        <StatusPill tone={TONE[d.status]}>{STATUS_TEXT[d.status]}</StatusPill>
        <span className="muted small">{d.statusReason}</span>
      </h1>
      <div className="grid-2">
        <Panel title="Now">
          <dl className="dl compact">
            <dt>Grid position</dt>
            <dd>
              row {d.row + 1}, col {d.col + 1}
            </dd>
            <dt>Sub-array</dt>
            <dd>{d.subarray ? <Link to={`/rta?subarray=${encodeURIComponent(d.subarray)}`}>{d.subarray}</Link> : '—'}</dd>
            <dt>Enabled / stowed</dt>
            <dd>
              {fmtAny(d.enabled)} / {fmtAny(d.stowed)}
            </dd>
            <dt>Fault code</dt>
            <dd>
              {d.faultCode ?? '—'}
              {d.faultCode && d.faultCode !== 'none' && (
                <>
                  {' '}
                  <SeverityBadge severity="critical">Fault</SeverityBadge>
                </>
              )}
            </dd>
            <dt>Temperature</dt>
            <dd>{d.temperatureK == null ? '—' : `${fmtNum(kToC(d.temperatureK), 1)} °C (${fmtNum(d.temperatureK, 1)} K)`}</dd>
            <dt>Power</dt>
            <dd>
              {fmtNum(d.powerW, 0)} W
              {d.powerOutlier && (
                <>
                  {' '}
                  <SeverityBadge severity="warning">Outlier vs array</SeverityBadge>
                </>
              )}
            </dd>
            <dt>System temperature</dt>
            <dd>{fmtNum(d.systemTemperatureK, 1)} K</dd>
            <dt>Pointing (az / el)</dt>
            <dd>
              {fmtNum(deg(d.azimuthRad), 2)}° / {fmtNum(deg(d.elevationRad), 2)}°
              {d.commanded && (
                <span className="muted small">
                  {' '}
                  commanded {fmtNum(deg(d.commanded.azimuth_rad), 2)}° / {fmtNum(deg(d.commanded.elevation_rad), 2)}°
                </span>
              )}
            </dd>
            <dt>Calibration</dt>
            <dd>
              {fmtTs(d.lastCalibration)}
              {d.calibrationAgeH != null && <span className="muted"> ({fmtNum(d.calibrationAgeH, 1)} h ago)</span>}
            </dd>
            <dt>Scan</dt>
            <dd>
              {d.scanId ? (
                <Link to={`/rta/scans/${d.scanId}`}>
                  {d.scanId}
                  {d.scanProgress != null && ` · ${Math.round(d.scanProgress * 100)}%`}
                </Link>
              ) : (
                '—'
              )}
              {d.meanSnrDb != null && <span className="muted"> · mean SNR {fmtNum(d.meanSnrDb, 1)} dB</span>}
            </dd>
            <dt>Last data</dt>
            <dd className="arl-num">
              {fmtTs(d.lastTs)} <span className="muted">({d.lastStream ?? '—'})</span>
            </dd>
          </dl>
        </Panel>
        <Panel title={`Open alerts (${alerts.length})`}>
          {alerts.length === 0 ? (
            <Empty>No open alerts for this dish.</Empty>
          ) : (
            <ul className="plain">
              {alerts.map((a) => (
                <li key={a.key}>
                  <Link to={alertHref(a)}>
                    <SeverityBadge severity={a.severity} compact /> {a.type} — {a.message}
                  </Link>{' '}
                  <span className="muted small">{a.opState}</span>
                </li>
              ))}
            </ul>
          )}
          <h3>State changes</h3>
          {!hist ? (
            <Loading what="history" />
          ) : hist.states.length === 0 ? (
            <Empty>No state changes in the window.</Empty>
          ) : (
            <ol className="timeline compact">
              {hist.states
                .slice(-40)
                .reverse()
                .map((s, i) => (
                  <li key={i}>
                    <span className="mono small">{fmtTs(s.ts)}</span> <strong>{s.item}</strong> {fmtAny(s.value)}
                  </li>
                ))}
            </ol>
          )}
        </Panel>
      </div>
      <div className="grid-2">
        <Panel title="Controls">
          <ControlPanel service="rta" entities={[d.id]} kinds={['dish']} />
        </Panel>
        <Panel title="Command history">
          <CommandHistory service="rta" entity={d.id} limit={8} />
        </Panel>
      </div>
      <Panel
        title="History"
        actions={
          <div className="seg" role="group" aria-label="Window">
            {[1, 6, 24, 72].map((h) => (
              <button key={h} type="button" className={h === hours ? 'on' : ''} onClick={() => setHours(h)}>
                {h} h
              </button>
            ))}
          </div>
        }
      >
        {error && <ErrorBox>{error}</ErrorBox>}
        {!charts ? (
          <Loading what="history" />
        ) : (
          <div className="charts">
            <div>
              <h3>Temperature vs irradiance</h3>
              <Chart
                ts={charts.temp.ts}
                values={charts.temp.values}
                axes={[
                  { scale: 'c', label: '°C' },
                  { scale: 'w', label: 'W/m²', side: 'right', range: [0, null] },
                ]}
                series={[
                  { label: 'Dish temp', color: colours.accent, scale: 'c' },
                  { label: 'Irradiance (LWM)', color: colours.ochre, scale: 'w' },
                ]}
              />
            </div>
            <div>
              <h3>Power and system temperature</h3>
              <Chart
                ts={charts.power.ts}
                values={charts.power.values}
                axes={[
                  { scale: 'w', label: 'W' },
                  { scale: 'k', label: 'K', side: 'right' },
                ]}
                series={[
                  { label: 'Power', color: colours.sunset, scale: 'w' },
                  { label: 'System temp', color: colours.dust, scale: 'k' },
                ]}
              />
            </div>
            <div>
              <h3>Pointing</h3>
              <Chart
                ts={charts.pointing.ts}
                values={charts.pointing.values}
                axes={[
                  { scale: 'el', label: 'Elevation °' },
                  { scale: 'az', label: 'Azimuth °', side: 'right', range: [0, 360] },
                ]}
                series={[
                  { label: 'Elevation', color: colours.accent, scale: 'el' },
                  { label: 'Azimuth', color: colours.sunset, scale: 'az' },
                ]}
              />
            </div>
            {charts.hasSnr && (
              <div>
                <h3>Scan SNR</h3>
                <Chart
                  ts={charts.snr.ts}
                  values={charts.snr.values}
                  axes={[{ scale: 'db', label: 'dB' }]}
                  series={[{ label: 'SNR', color: colours.accent, scale: 'db', width: 1 }]}
                />
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
