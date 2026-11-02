// uPlot wrapper: time axis in Africa/Johannesburg, resizes with its container, data replaced in place.
import { useEffect, useRef } from 'react';
import uPlot, { type AlignedData, type Options, type Series } from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { cssVar, useThemeColors } from '../lib/colors';
import { TZ } from '../lib/format';
import { useTheme } from '../lib/theme';

export interface ChartSeries {
  label: string;
  color: string;
  scale?: string;
  width?: number;
  dash?: number[];
  /** Step line (state-like series). */
  step?: boolean;
  fill?: string;
  /** Break the line at nulls. Off by default: aligned series of different rates have nulls between points. */
  gaps?: boolean;
}

export interface ChartAxis {
  scale: string;
  label: string;
  side?: 'left' | 'right';
  range?: [number | null, number | null];
}

const axisStyle = (inkMuted: string, line: string) => ({
  stroke: inkMuted,
  grid: { stroke: line, width: 1 },
  ticks: { stroke: line, width: 1 },
  font: `12px ${cssVar('--font-data') || 'sans-serif'}`,
});

export function Chart({
  ts,
  values,
  series,
  axes,
  height = 200,
  title,
}: {
  /** Sim timestamps in ms. */
  ts: number[];
  values: (number | null)[][];
  series: ChartSeries[];
  axes: ChartAxis[];
  height?: number;
  title?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const { theme } = useTheme();
  const c = useThemeColors();
  const AXIS = axisStyle(c.inkMuted, c.line);
  // the theme is part of the shape so the plot is rebuilt with the new palette
  const shape = JSON.stringify({ series, axes, height, title, theme });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const scales: Options['scales'] = { x: { time: true } };
    for (const a of axes) {
      scales[a.scale] = a.range ? { range: (_u, min, max) => [a.range![0] ?? min, a.range![1] ?? max] } : { auto: true };
    }
    const opts: Options = {
      width: Math.max(200, el.clientWidth),
      height,
      ...(title ? { title } : {}),
      tzDate: (sec) => uPlot.tzDate(new Date(sec * 1e3), TZ),
      scales,
      legend: { live: true },
      cursor: { drag: { x: true, y: false } },
      axes: [
        { ...AXIS },
        ...axes.map((a) => ({
          ...AXIS,
          scale: a.scale,
          label: a.label,
          side: a.side === 'right' ? 1 : 3,
          size: 56,
          ...(a.side === 'right' ? { grid: { show: false } } : {}),
        })),
      ],
      series: [
        {},
        ...series.map(
          (s): Series => ({
            label: s.label,
            stroke: s.color,
            width: s.width ?? 1.5,
            scale: s.scale ?? axes[0]?.scale ?? 'y',
            spanGaps: !s.gaps,
            ...(s.dash ? { dash: s.dash } : {}),
            ...(s.fill ? { fill: s.fill } : {}),
            ...(s.step ? { paths: uPlot.paths.stepped!({ align: 1 }) } : {}),
          }),
        ),
      ],
    };
    const u = new uPlot(opts, toData(ts, values), el);
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: Math.max(200, el.clientWidth), height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
    // the plot is rebuilt only when its shape changes; data updates go through setData below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  useEffect(() => {
    plot.current?.setData(toData(ts, values));
  }, [ts, values]);

  return <div ref={host} className="chart" />;
}

function toData(ts: number[], values: (number | null)[][]): AlignedData {
  return [ts.map((t) => t / 1000), ...values] as AlignedData;
}

/** Aligns several (ts, value) series onto one sorted time axis (nulls where a series has no point). */
export function alignSeries(list: { ts: number[]; v: (number | null)[] }[]): { ts: number[]; values: (number | null)[][] } {
  const all = new Set<number>();
  for (const s of list) for (const t of s.ts) all.add(t);
  const ts = [...all].sort((a, b) => a - b);
  const index = new Map(ts.map((t, i) => [t, i]));
  const values = list.map((s) => {
    const out: (number | null)[] = new Array(ts.length).fill(null);
    s.ts.forEach((t, i) => (out[index.get(t)!] = s.v[i] ?? null));
    return out;
  });
  return { ts, values };
}

/** Carries a step series forward over the aligned axis (state values hold until the next change). */
export function holdForward(v: (number | null)[]): (number | null)[] {
  let last: number | null = null;
  return v.map((x) => (x === null ? last : (last = x)));
}
