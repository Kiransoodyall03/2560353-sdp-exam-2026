// The five weather sites as cards: latest readings, the derived numbers (dew point, hourly rain rate, 3 h
// pressure tendency, battery) and the site's extra instrument (sonic on lwm-3, soiling on lwm-4, pan on
// lwm-5). Each card carries its own collapsible control panel scoped to that one site, so a control is never
// broadcast and the entity-restricted commands (clean the reference cell, refill the pan) appear only where
// they apply. All numbers come from the server; the card only formats and colours them.
import { ControlPanel } from '../ControlPanel';
import { StatusPill, type Tone } from '../ui';
import { fmtAgo, fmtNum } from '../../lib/format';
import { compassFromRad, fmtC, fmtSigned, type LwmLimits, type LwmSiteDTO } from '../../lib/lwm';

function Metric({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="site-metric">
      <span className="kv-k">{label}</span>
      <span className={tone ? `tone-${tone}` : undefined}>{value}</span>
    </div>
  );
}

function gustTone(g: number | null, limits: LwmLimits): Tone | undefined {
  if (g == null) return undefined;
  return g > limits.highWindCritMs ? 'bad' : g > limits.highWindWarnMs ? 'warn' : 'ok';
}

function tempTone(k: number | null, limits: LwmLimits): Tone | undefined {
  if (k == null) return undefined;
  return k < limits.temperatureMinK || k > limits.temperatureMaxK ? 'warn' : undefined;
}

export function SiteCards({ sites, now, limits }: { sites: LwmSiteDTO[]; now: number | null; limits: LwmLimits }) {
  if (sites.length === 0) return <p className="muted small">No sites yet.</p>;
  return (
    <div className="tiles site-tiles">
      {sites.map((s) => {
        const w = s.latest;
        const d = s.derived;
        const stateTone: Tone = s.backfilling ? 'info' : s.online ? 'ok' : s.enabled === false ? 'idle' : 'bad';
        const stateText = s.backfilling ? 'backfilling' : s.online ? 'online' : s.enabled === false ? 'disabled' : 'offline';
        return (
          <div key={s.id} className={`tile ${s.online || s.backfilling ? '' : 'tile-stale'}`}>
            <div className="tile-head">
              <div>
                <div className="tile-code">{s.id}</div>
                <div className="tile-name">
                  {w ? `updated ${fmtAgo(w.ts, now)}` : 'no sample yet'}
                  {s.sampleIntervalS != null ? ` · every ${s.sampleIntervalS} s` : ''}
                </div>
              </div>
              <StatusPill tone={stateTone} title={stateText}>
                {stateText}
              </StatusPill>
            </div>

            <div className="site-metrics">
              <Metric label="Temp" value={fmtC(w?.temperatureK)} tone={tempTone(w?.temperatureK ?? null, limits)} />
              <Metric label="Dew point" value={fmtC(d.dewPointK)} />
              <Metric label="Humidity" value={w?.humidityPct == null ? '—' : `${fmtNum(w.humidityPct, 0)} %`} />
              <Metric label="Pressure" value={w?.pressureHpa == null ? '—' : `${fmtNum(w.pressureHpa, 1)} hPa`} />
              <Metric label="3 h trend" value={fmtSigned(d.pressureTendencyHpa3h, 'hPa')} />
              <Metric label="Wind" value={w?.windSpeedMs == null ? '—' : `${fmtNum(w.windSpeedMs, 1)} m/s ${compassFromRad(w.windDirectionRad) ?? ''}`} />
              <Metric label="Gust" value={w?.windGustMs == null ? '—' : `${fmtNum(w.windGustMs, 1)} m/s`} tone={gustTone(w?.windGustMs ?? null, limits)} />
              <Metric label="Rain rate" value={d.rainRateMmH == null ? '—' : `${fmtNum(d.rainRateMmH, 1)} mm/h`} tone={d.rainRateMmH != null && d.rainRateMmH > limits.rainMaxMmH ? 'warn' : undefined} />
              <Metric label="Irradiance" value={w?.irradianceWm2 == null ? '—' : `${fmtNum(w.irradianceWm2, 0)} W/m²`} />
              <Metric label="Battery" value={d.battery.batteryV == null ? '—' : `${fmtNum(d.battery.batteryV, 2)} V`} tone={d.battery.batteryV != null && d.battery.batteryV <= limits.batteryMinV ? 'bad' : undefined} />
            </div>

            {s.sonic && (
              <p className="muted small site-extra">
                Sonic: {fmtC(s.sonic.sonicTemperatureK)} · Δ {fmtSigned(d.sonicDeltaK, 'K', 2)} vs main
              </p>
            )}
            {s.soiling && (
              <p className="muted small site-extra">
                Soiling ratio {s.soiling.soilingRatio == null ? '—' : fmtNum(s.soiling.soilingRatio, 3)}
                {s.soiling.soilingRatio != null && s.soiling.soilingRatio < limits.soilingMinRatio ? ' · below clean threshold' : ''}
              </p>
            )}
            {s.pan && (
              <p className="muted small site-extra">
                Pan {s.pan.panLevelMm == null ? '—' : `${fmtNum(s.pan.panLevelMm, 1)} mm`}
                {s.pan.panLevelMm != null && s.pan.panLevelMm < limits.panMinMm ? ' · low' : s.pan.panLevelMm != null && s.pan.panLevelMm > limits.panMaxMm ? ' · full' : ''}
                {s.pan.evaporationMm != null ? ` · evap ${fmtNum(s.pan.evaporationMm, 1)} mm` : ''}
              </p>
            )}

            <ControlPanel service="lwm" entities={[s.id]} kinds={['site']} collapsible title="Site controls" />
          </div>
        );
      })}
    </div>
  );
}
