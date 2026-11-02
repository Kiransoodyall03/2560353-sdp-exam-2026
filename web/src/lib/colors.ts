// Bridge between the CSS design tokens and the places that cannot read CSS: canvas pixels and uPlot
// options. Every colour here is read from tokens.css, so nothing in the app hard-codes a value.
import { useMemo } from 'react';
import { useTheme } from './theme';

/** Current value of one design token, e.g. cssVar('--accent'). */
export function cssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export type RGB = [number, number, number];

export interface ThemeColors {
  /** Chart/series order: accent, sunset, ochre, dust, ink-muted. */
  series: string[];
  ink: string;
  inkMuted: string;
  line: string;
  lineStrong: string;
  surfacePage: string;
  surfacePanel: string;
  surfaceSunken: string;
  accent: string;
  sunset: string;
  ochre: string;
  dust: string;
  alarmCritical: string;
  alarmWarning: string;
  stale: string;
  rampPeak: string;
}

function read(): ThemeColors {
  const accent = cssVar('--accent');
  const sunset = cssVar('--sunset');
  const ochre = cssVar('--ochre');
  const dust = cssVar('--dust');
  const inkMuted = cssVar('--ink-muted');
  return {
    series: [accent, sunset, ochre, dust, inkMuted],
    ink: cssVar('--ink'),
    inkMuted,
    line: cssVar('--line'),
    lineStrong: cssVar('--line-strong'),
    surfacePage: cssVar('--surface-page'),
    surfacePanel: cssVar('--surface-panel'),
    surfaceSunken: cssVar('--surface-sunken'),
    accent,
    sunset,
    ochre,
    dust,
    alarmCritical: cssVar('--alarm-critical'),
    alarmWarning: cssVar('--alarm-warning'),
    stale: cssVar('--stale'),
    rampPeak: cssVar('--ramp-peak'),
  };
}

/** Tokens for drawing code; recomputed whenever the theme changes. */
export function useThemeColors(): ThemeColors {
  const { theme } = useTheme();
  return useMemo(read, [theme]);
}

/** "#rrggbb" / "#rgb" → channel triple. Anything unparseable falls back to mid grey. */
export function toRgb(css: string): RGB {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return [128, 128, 128];
  const h = m[1]!;
  if (h.length === 3) {
    return [parseInt(h[0]! + h[0]!, 16), parseInt(h[1]! + h[1]!, 16), parseInt(h[2]! + h[2]!, 16)];
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Sequential ramp stops: surface-sunken → dust → ochre → accent → ramp-peak. */
export function sequentialStops(c: ThemeColors): RGB[] {
  return [toRgb(c.surfaceSunken), toRgb(c.dust), toRgb(c.ochre), toRgb(c.accent), toRgb(c.rampPeak)];
}

/** Diverging ramp stops: sunset ↔ dust ↔ accent. */
export function divergingStops(c: ThemeColors): RGB[] {
  return [toRgb(c.sunset), toRgb(c.dust), toRgb(c.accent)];
}

/** Interpolate a t (0..1) over evenly spaced stops. */
export function rampAt(stops: RGB[], t: number): RGB {
  if (stops.length === 0) return [128, 128, 128];
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const a = stops[i] ?? stops[0]!;
  const b = stops[i + 1] ?? a;
  const f = x - i;
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

export const rgbCss = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
