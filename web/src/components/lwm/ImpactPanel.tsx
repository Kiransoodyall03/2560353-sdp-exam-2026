// Impact panel: what the weather did to the other services over the last three hours. Three small charts
// share one time axis: the LWM max gust against the RTA wind-stow limit, the RTA stowed dish count and the
// OPG solar output. The gust and stow series come from the RTA trend endpoint (it already aggregates LWM
// gusts and sweeps RTA stow state changes), the solar series from the OPG trend — both read-only REST, no
// extra live channels, so the page keeps its connection budget. A generated caption states the correlation
// in words: when the gust crossed the stow limit, how many dishes stowed and how far the solar output fell.
import { useEffect, useMemo, useState } from 'react';
import { Chart } from '../Chart';
import { ErrorBox, Loading } from '../ui';
import { api, errorText } from '../../lib/api';
import { useThemeColors } from '../../lib/colors';
import { fmtNum, fmtTime } from '../../lib/format';

const WINDOW_HOURS = 3;
const POLL_MS = 60_000;

interface RtaTrendLite {
  from: number;
  to: number;
  windStowGustMs: number | null;
  gust: { ts: number[]; value: number[] };
  stowed: { ts: number[]; count: number[] };
}

interface OpgTrendLite {
  from: number;
  to: number;
  series: { ts: number[]; solarW: (number | null)[] };
}

interface Caption {
  text: string;
  /** The moment the caption talks about, for the chart footnote. */
  at: number | null;
}

/**
 * Find the first sustained crossing of the stow limit (two consecutive buckets above it) and describe the
 * consequences: dishes stowed at the crossing and the deepest solar drop inside the 40 minutes after it.
 */
function buildCaption(rta: RtaTrendLite, opg: OpgTrendLite): Caption {
  const limit = rta.windStowGustMs;
  if (limit == null || rta.gust.ts.length === 0) return { text: 'No stow limit published, so the gust cannot be compared yet.', at: null };
  let crossIdx = -1;
  for (let i = 1; i < rta.gust.ts.length; i++) {
    const a = rta.gust.value[i - 1];
    const b = rta.gust.value[i];
    if (a != null && b != null && a > limit && b > limit) {
      crossIdx = i;
      break;
    }
  }
  if (crossIdx < 0) {
    const peak = Math.max(...rta.gust.value.filter((v): v is number => v != null));
    return { text: `Max gust ${fmtNum(peak, 1)} m/s stayed below the ${fmtNum(limit, 0)} m/s stow limit; no dishes were stowed by wind.`, at: null };
  }
  const crossTs = rta.gust.ts[crossIdx]!;
  const gustV = rta.gust.value[crossIdx] ?? null;
  let stowedAtCross: number | null = null;
  for (let i = 0; i < rta.stowed.ts.length; i++) {
    if (rta.stowed.ts[i]! <= crossTs) stowedAtCross = rta.stowed.count[i]! ?? null;
    else break;
  }
  // solar before vs the trough after: mean of the 30 min before, min of the 40 min after
  const before: number[] = [];
  const after: number[] = [];
  for (let i = 0; i < opg.series.ts.length; i++) {
    const v = opg.series.solarW[i];
    if (v == null) continue;
    const t = opg.series.ts[i]!;
    if (t >= crossTs - 30 * 60_000 && t < crossTs) before.push(v);
    else if (t >= crossTs && t <= crossTs + 40 * 60_000) after.push(v);
  }
  const mean = before.length ? before.reduce((a, b) => a + b, 0) / before.length : null;
  const trough = after.length ? Math.min(...after) : null;
  const fell = mean != null && trough != null && mean > 0 ? Math.max(0, 1 - trough / mean) : null;
  const bits = [`Gust exceeded ${fmtNum(limit, 0)} m/s at ${fmtTime(crossTs)}`];
  if (gustV != null) bits.push(`(peak ${fmtNum(gustV, 1)} m/s in the window)`);
  bits.push(`; ${stowedAtCross ?? 0} dishes stowed`);
  if (fell != null && fell > 0.02) bits.push(`; solar fell ${Math.round(fell * 100)} % within 40 min`);
  return { text: bits.join(' ').replace(' ;', ';') + '.', at: crossTs };
}

export function ImpactPanel() {
  const colours = useThemeColors();
  const [rta, setRta] = useState<RtaTrendLite | null>(null);
  const [opg, setOpg] = useState<OpgTrendLite | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    const load = () =>
      Promise.all([
        api.get<RtaTrendLite>(`/api/rta/trend?hours=${WINDOW_HOURS}`, { signal: ac.signal }),
        api.get<OpgTrendLite>(`/api/opg/trend?hours=${WINDOW_HOURS}`, { signal: ac.signal }),
      ])
        .then(([r, o]) => {
          if (!alive) return;
          setRta(r);
          setOpg(o);
          setError(null);
        })
        .catch((err: unknown) => {
          if (alive && (err as Error).name !== 'AbortError') setError(errorText(err));
        });
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      ac.abort();
    };
  }, []);

  const caption = useMemo<Caption | null>(() => (rta && opg ? buildCaption(rta, opg) : null), [rta, opg]);

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!rta || !opg) return <Loading what="the last three hours" />;

  const limit = rta.windStowGustMs;
  const solarKw = opg.series.solarW.map((w) => (w == null ? null : w / 1000));
  // a constant series on the gust axis: uPlot needs one value per x point, so repeat the limit across ts
  const limitLine = limit == null ? null : rta.gust.ts.map(() => limit);

  return (
    <div className="impact-panel">
      <div className="impact-row">
        <span className="impact-label">LWM max gust vs RTA stow limit</span>
        <Chart
          ts={rta.gust.ts}
          values={limitLine ? [rta.gust.value, limitLine] : [rta.gust.value]}
          series={[
            { label: 'Gust', color: colours.ochre, scale: 'ms' },
            ...(limit != null ? [{ label: `Stow limit ${limit} m/s`, color: colours.ink, scale: 'ms', dash: [6, 4] }] : []),
          ]}
          axes={[{ scale: 'ms', label: 'm/s', range: [0, null] }]}
          height={120}
        />
      </div>
      <div className="impact-row">
        <span className="impact-label">RTA stowed dishes</span>
        <Chart
          ts={rta.stowed.ts}
          values={[rta.stowed.count]}
          series={[{ label: 'Stowed', color: colours.sunset, scale: 'n', step: true, width: 2 }]}
          axes={[{ scale: 'n', label: 'Dishes', range: [0, null] }]}
          height={92}
        />
      </div>
      <div className="impact-row">
        <span className="impact-label">OPG solar output</span>
        <Chart
          ts={opg.series.ts}
          values={[solarKw]}
          series={[{ label: 'Solar', color: colours.accent, scale: 'kw' }]}
          axes={[{ scale: 'kw', label: 'kW', range: [0, null] }]}
          height={92}
        />
      </div>
      <p className="muted small">
        All three rows share the same {WINDOW_HOURS}-hour window
        {caption?.at != null ? ` and the same moment: the crossing at ${fmtTime(caption.at)}` : ''}.
      </p>
      {caption && <p className="impact-caption">{caption.text}</p>}
    </div>
  );
}
