// Sonic vs main thermometer (lwm-3 only). The sonic anemometer measures its own temperature; comparing it
// with the site's shielded thermometer is a drift check — a growing gap points at a sensor that needs the
// recalibration the controls offer. The live delta comes from the server; the optional trend is aligned from
// the site's history (sonic_temperature_k against the nearest weather temperature_k).
import { Chart } from '../Chart';
import { Empty, SeverityBadge } from '../ui';
import { useThemeColors } from '../../lib/colors';
import { deg, fmtNum } from '../../lib/format';
import { fmtC, type SonicPoint } from '../../lib/lwm';

/** |Δ| above this many kelvin reads as a probable drift rather than measurement noise. */
const DRIFT_WARN_K = 2;

export function SonicDiff({
  sonic,
  temperatureK,
  deltaK,
  series,
}: {
  sonic: SonicPoint | null;
  temperatureK: number | null;
  deltaK: number | null;
  series?: { ts: number[]; deltaK: (number | null)[] } | null;
}) {
  const colours = useThemeColors();
  if (!sonic && deltaK == null && temperatureK == null) {
    return <Empty>No sonic anemometer data yet (lwm-3).</Empty>;
  }
  const drift = deltaK != null && Math.abs(deltaK) > DRIFT_WARN_K;
  const hasSeries = series && series.ts.length > 1;

  return (
    <div className="sonic-diff">
      <div className="reading-head">
        <span className="arl-label">Sonic minus main thermometer</span>
        {drift && <SeverityBadge severity="warning">Drift</SeverityBadge>}
      </div>
      <div className="arl-reading">
        {deltaK == null ? '—' : `${deltaK > 0 ? '+' : deltaK < 0 ? '−' : ''}${Math.abs(deltaK).toFixed(2)}`}
        <small>K</small>
      </div>
      <dl className="facts">
        <div>
          <dt>Sonic temp</dt>
          <dd>{fmtC(sonic?.sonicTemperatureK)}</dd>
        </div>
        <div>
          <dt>Main temp</dt>
          <dd>{fmtC(temperatureK)}</dd>
        </div>
        <div>
          <dt>Wind u / v / w</dt>
          <dd>
            {fmtNum(sonic?.windUMs)} / {fmtNum(sonic?.windVMs)} / {fmtNum(sonic?.windWMs)} m/s
          </dd>
        </div>
        <div>
          <dt>Turbulence</dt>
          <dd>{fmtNum(sonic?.turbulenceIntensity, 2)}</dd>
        </div>
        <div>
          <dt>Gust factor</dt>
          <dd>{fmtNum(sonic?.gustFactor, 2)}</dd>
        </div>
        <div>
          <dt>Direction σ</dt>
          <dd>{sonic?.directionStdRad == null ? '—' : `${fmtNum(deg(sonic.directionStdRad), 1)}°`}</dd>
        </div>
      </dl>
      {hasSeries ? (
        <>
          <h3>Difference over time</h3>
          <Chart
            ts={series!.ts}
            values={[series!.deltaK]}
            series={[{ label: 'Sonic minus main (K)', color: colours.sunset, width: 1.5 }]}
            axes={[{ scale: 'y', label: 'K' }]}
            height={150}
          />
        </>
      ) : (
        <p className="muted small">
          {drift
            ? 'A gap this wide usually means the sonic temperature sensor has drifted: consider a recalibration when the wind is calm.'
            : 'A small, steady gap is normal; a widening one flags sensor drift.'}
        </p>
      )}
    </div>
  );
}
