// IDW weather field on a canvas: the server sends a row-major grid (row 0 = north) plus the bounds, so
// the client only projects lat/lon to pixels — no map tiles, just the arl.geojson outline underneath and
// a marker per site. The field is drawn to a cols×rows offscreen canvas then scaled up with smoothing so
// the interpolation looks continuous. Works identically in replay: the page passes a historical ts and the
// server returns whatever samples were latest then.
//
// Layers on top of the field, all drawn in the same single pass (redraw only when data or the scrubbed
// frame changes): interpolated wind arrows (u/v components, never angles), pressure isobars by marching
// squares, lightning strikes of the last 30 min plotted at their distance/bearing from the detecting site
// with the alert-distance ring, per-site wind barbs, a variable switcher and a 60-minute time-lapse that
// replays keyframe fields — anchored at the scrub time when the page is scrubbing, at "now" otherwise.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cssVar, rampAt, rgbCss, sequentialStops, toRgb, useThemeColors, type ThemeColors } from '../../lib/colors';
import {
  fetchLwmMap,
  fmtMapValue,
  idwAtPoint,
  isobarStep,
  kmPxScale,
  marchingSquares,
  timeLapseTimes,
  windBarbClasses,
  windUVfromSpeedDir,
  type LwmLimits,
  type LwmSiteDTO,
  type LwmStrike,
  type LwmMapDTO,
  type SiteSample,
  type WindBarbClasses,
} from '../../lib/lwm';
import { fmtTime } from '../../lib/format';

const KM_PER_DEG_LAT = 110.574;
const HOUR_MS = 3_600_000;
const STRIKE_WINDOW_MS = 30 * 60_000;
const LAPSE_FRAMES = 13; // 5-minute steps over the last hour
const LAPSE_STEP_MS = 1_100;

const VARIABLE_OPTIONS = [
  { id: 'temperature_k', label: 'Temperature' },
  { id: 'pressure_hpa', label: 'Pressure' },
  { id: 'wind_speed_ms', label: 'Wind' },
  { id: 'humidity_pct', label: 'Humidity' },
  { id: 'rainfall_mm', label: 'Rain' },
];

// ------------------------------------------------------------------- icons
function VariableIcon({ id }: { id: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  switch (id) {
    case 'temperature_k':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...common}>
          <path d="M6.5 9.2V3a1.5 1.5 0 0 1 3 0v6.2a3 3 0 1 1-3 0z" />
          <path d="M8 6.5v4" />
        </svg>
      );
    case 'pressure_hpa':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...common}>
          <circle cx="8" cy="8" r="5.6" />
          <circle cx="8" cy="8" r="2.6" />
          <path d="M8 2.4v1.4M13.6 8h-1.4M8 13.6v-1.4M2.4 8h1.4" />
        </svg>
      );
    case 'wind_speed_ms':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...common}>
          <path d="M2 6h8a2 2 0 1 0-2-2" />
          <path d="M2 10h10a2 2 0 1 1-2 2" />
        </svg>
      );
    case 'humidity_pct':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...common}>
          <path d="M8 2.2c2.6 3 4.4 5 4.4 7.2a4.4 4.4 0 1 1-8.8 0c0-2.2 1.8-4.2 4.4-7.2z" />
        </svg>
      );
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...common}>
          <path d="M4.5 8.5a2.8 2.8 0 1 1 1.2-5.1A3.4 3.4 0 0 1 12 5a2.3 2.3 0 0 1-.4 4.5" />
          <path d="M5 11.2l-.8 2.2M8 11.2l-.8 2.2M11 11.2l-.8 2.2" />
        </svg>
      );
  }
}

// ---------------------------------------------------------------- projection
/** A linear equirectangular projection that keeps the campus shape honest (lon scaled by cos lat). */
function makeProjector(bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number }, widthPx: number, heightPx: number) {
  const lonSpan = bounds.maxLon - bounds.minLon || 1e-9;
  const latSpan = bounds.maxLat - bounds.minLat || 1e-9;
  return (lon: number, lat: number): [number, number] => {
    const x = ((lon - bounds.minLon) / lonSpan) * widthPx;
    const y = ((bounds.maxLat - lat) / latSpan) * heightPx;
    return [x, y];
  };
}

/** Canvas height that matches the geographic aspect ratio of the bounds for a given width. */
function heightFor(bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number }, widthPx: number): number {
  const meanLat = ((bounds.minLat + bounds.maxLat) / 2) * (Math.PI / 180);
  const kmLon = (bounds.maxLon - bounds.minLon) * KM_PER_DEG_LAT * Math.cos(meanLat);
  const kmLat = (bounds.maxLat - bounds.minLat) * KM_PER_DEG_LAT;
  if (kmLon <= 0) return widthPx;
  return Math.round(widthPx * (kmLat / kmLon));
}

/** Strokes every line/ring in a GeoJSON coordinate tree; lone points are skipped (the outline is polygons). */
function strokeGeo(ctx: CanvasRenderingContext2D, coords: unknown, project: (lon: number, lat: number) => [number, number]): void {
  if (!Array.isArray(coords) || coords.length === 0) return;
  if (typeof coords[0] === 'number') return; // a single position
  const first = coords[0] as unknown;
  if (Array.isArray(first) && typeof first[0] === 'number') {
    ctx.beginPath();
    (coords as [number, number][]).forEach((p, i) => {
      const [x, y] = project(p[0], p[1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    return;
  }
  for (const c of coords) strokeGeo(ctx, c, project);
}

// ---------------------------------------------------------------- wind barb
const BARB_STAFF = 13;
const BARB_GAP = 2.4;
const BARB_LEN = 5;

/** Classic synoptic barb, drawn on canvas: staff points toward where the wind comes FROM, feathers left. */
function drawBarb(ctx: CanvasRenderingContext2D, x: number, y: number, fromDirRad: number, classes: WindBarbClasses, colour: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(fromDirRad); // local -y is the FROM direction
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -BARB_STAFF);
  ctx.stroke();
  let along = -BARB_STAFF;
  for (let i = 0; i < classes.pennants; i++) {
    ctx.beginPath();
    ctx.moveTo(0, along);
    ctx.lineTo(-4.5, along + 2.4);
    ctx.lineTo(0, along + 4.8);
    ctx.closePath();
    ctx.fill();
    along += 5.2;
  }
  for (let i = 0; i < classes.full; i++) {
    ctx.beginPath();
    ctx.moveTo(0, along);
    ctx.lineTo(-BARB_LEN, along);
    ctx.stroke();
    along += BARB_GAP;
  }
  if (classes.half) {
    ctx.beginPath();
    ctx.moveTo(0, along);
    ctx.lineTo(-BARB_LEN / 2, along);
    ctx.stroke();
  }
  ctx.restore();
}

/** The same barb for the site cards, as inline SVG (staff up, rotated so feathers read correctly). */
export function WindBarbSvg({ speedMs, dirRad, size = 26, title }: { speedMs: number | null; dirRad: number | null; size?: number; title?: string }) {
  const c = useThemeColors();
  if (speedMs == null || dirRad == null) return <span className="muted small" style={{ fontSize: 11 }}>no wind</span>;
  const calm = speedMs < 0.5;
  const classes = windBarbClasses(speedMs);
  const cxx = size / 2;
  const cyy = size / 2;
  const staff = size / 2 - 2;
  const feather = (yEnd: number, len: number) => <line key={`f${yEnd}`} x1={cxx} y1={yEnd} x2={cxx - len} y2={yEnd} stroke={c.ink} strokeWidth={1.2} />;
  let along = cyy - staff;
  const parts: ReactNode[] = [];
  for (let i = 0; i < classes.pennants; i++) {
    parts.push(
      <path key={`p${i}`} d={`M ${cxx} ${along} L ${cxx - 4.5} ${along + 2.4} L ${cxx} ${along + 4.8} Z`} fill={c.ink} />,
    );
    along += 5.2;
  }
  for (let i = 0; i < classes.full; i++) {
    parts.push(feather(along, 5));
    along += 2.4;
  }
  if (classes.half) parts.push(feather(along, 2.5));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={title ?? `wind ${speedMs.toFixed(1)} m/s`}
      style={{ overflow: 'visible' }}
    >
      <g transform={`rotate(${(dirRad * 180) / Math.PI} ${cxx} ${cyy})`}>
        {calm ? <circle cx={cxx} cy={cyy} r={3.2} fill="none" stroke={c.ink} strokeWidth={1.2} /> : <line x1={cxx} y1={cyy} x2={cxx} y2={cyy - staff} stroke={c.ink} strokeWidth={1.3} />}
        {!calm && parts}
      </g>
    </svg>
  );
}

function barbClassesFor(speedMs: number): WindBarbClasses {
  return windBarbClasses(speedMs);
}

// ------------------------------------------------------------- site vectors
interface SiteVector {
  id: string;
  lat: number;
  lon: number;
  speedMs: number | null;
  dirFromRad: number | null;
}

function buildSiteVectors(fieldSites: SiteSample[], snapshot: LwmSiteDTO[]): SiteVector[] {
  const windById = new Map(snapshot.map((s) => [s.id, s.latest]));
  return fieldSites
    .map((g) => {
      const w = windById.get(g.id);
      const uv = windUVfromSpeedDir(w?.windSpeedMs, w?.windDirectionRad);
      const speedMs = uv.u != null && uv.v != null ? Math.hypot(uv.u, uv.v) : null;
      // the field sites carry NaN when the server has no position: fall back to the snapshot position
      const lat = Number.isFinite(g.lat) ? g.lat : (snapshot.find((s) => s.id === g.id)?.position?.lat ?? NaN);
      const lon = Number.isFinite(g.lon) ? g.lon : (snapshot.find((s) => s.id === g.id)?.position?.lon ?? NaN);
      return { id: g.id, lat, lon, speedMs, dirFromRad: w?.windDirectionRad ?? null };
    })
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

// ---------------------------------------------------------------- drawing
interface DrawArgs {
  map: LwmMapDTO;
  geojson: unknown | null;
  sites: SiteVector[];
  lightning: { strikes: LwmStrike[]; siteById: Map<string, { lat: number; lon: number }>; center: { lat: number; lon: number } | null; alertKm: number; anchorTs: number };
  width: number;
  heightPx: number;
  c: ThemeColors;
}

function drawField(ctx: CanvasRenderingContext2D, { map, geojson, sites, lightning, width, heightPx, c }: DrawArgs): void {
  const grid = map.grid;
  const bounds = map.bounds;
  const stops = sequentialStops(c);
  ctx.fillStyle = c.surfaceSunken;
  ctx.fillRect(0, 0, width, heightPx);

  // --- field: render the grid 1px-per-cell offscreen, then scale up with bilinear smoothing
  const off = document.createElement('canvas');
  off.width = grid.cols;
  off.height = grid.rows;
  const octx = off.getContext('2d');
  if (octx) {
    const img = octx.createImageData(grid.cols, grid.rows);
    const lo = map.min;
    const hi = map.max;
    const span = lo != null && hi != null && hi > lo ? hi - lo : null;
    for (let i = 0; i < grid.values.length; i++) {
      const v = grid.values[i];
      const o = i * 4;
      if (v == null || span == null || lo == null) {
        img.data[o + 3] = 0;
        continue;
      }
      const [r, g, b] = rampAt(stops, (v - lo) / span);
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 220;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, 0, 0, grid.cols, grid.rows, 0, 0, width, heightPx);
  }

  const project = makeProjector(bounds, width, heightPx);
  // node projector: grid node (row r, col c) → pixels (the field image stretches nodes over the canvas)
  const nx = (col: number): number => (grid.cols === 1 ? width / 2 : (col / (grid.cols - 1)) * width);
  const ny = (row: number): number => (grid.rows === 1 ? heightPx / 2 : (row / (grid.rows - 1)) * heightPx);
  const fontData = `10px ${cssVar('--font-data') || 'sans-serif'}`;

  // --- campus outline on top of the field
  if (geojson) {
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1.25;
    const gj = geojson as { features?: { geometry?: { coordinates?: unknown } }[]; coordinates?: unknown };
    if (Array.isArray(gj.features)) for (const f of gj.features) strokeGeo(ctx, f.geometry?.coordinates, project);
    else strokeGeo(ctx, gj.coordinates, project);
  }

  // --- lightning: range ring at the alert distance + strikes of the last 30 min, fading with age
  const recent = lightning.strikes.filter((s) => s.ts > lightning.anchorTs - STRIKE_WINDOW_MS && s.distanceKm != null && s.bearingRad != null);
  if (recent.length > 0) {
    const { kmPerPxX, kmPerPxY } = kmPxScale(bounds, width, heightPx);
    const oldest = recent[0]!.ts;
    const newest = recent[recent.length - 1]!.ts;
    const span = Math.max(1, newest - oldest);
    ctx.font = fontData;
    for (const s of recent) {
      const det = (s.detectedBy[0] ? lightning.siteById.get(s.detectedBy[0]) : undefined) ?? lightning.center;
      if (!det || s.distanceKm == null || s.bearingRad == null) continue;
      // local east-north frame at the detecting site, in px
      const cosLat = Math.cos((det.lat * Math.PI) / 180);
      const dLonKm = KM_PER_DEG_LAT * cosLat;
      const [detX, detY] = project(det.lon, det.lat);
      const x = detX + (Math.sin(s.bearingRad) * s.distanceKm) / dLonKm / kmPerPxX;
      const y = detY - (Math.cos(s.bearingRad) * s.distanceKm) / KM_PER_DEG_LAT / kmPerPxY;
      const ageFrac = (s.ts - oldest) / span; // 0 oldest … 1 newest
      ctx.globalAlpha = 0.25 + 0.65 * ageFrac;
      ctx.fillStyle = c.ochre;
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // one dashed range ring at the alert distance, around the site that detected the newest strike
    const newestStrike = recent[recent.length - 1]!;
    const ringSite = (newestStrike.detectedBy[0] ? lightning.siteById.get(newestStrike.detectedBy[0]) : undefined) ?? lightning.center;
    if (ringSite && lightning.alertKm > 0) {
      const [rx0, ry0] = project(ringSite.lon, ringSite.lat);
      const kmPerPx = (kmPerPxX + kmPerPxY) / 2;
      const rPx = kmPerPx > 0 ? lightning.alertKm / kmPerPx : 0;
      ctx.strokeStyle = c.alarmWarning;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(rx0, ry0, rPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.alarmWarning;
      ctx.textAlign = 'left';
      ctx.fillText(`${lightning.alertKm} km`, rx0 + 4, ry0 - rPx - 3);
    }
  }

  // --- isobars (pressure variable only): marching squares over the same IDW grid the field shows
  if (map.variable === 'pressure_hpa' && map.min != null && map.max != null) {
    const step = isobarStep(map.max - map.min);
    const levels = marchingSquares(grid, step);
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1;
    for (const lv of levels) {
      ctx.beginPath();
      for (const seg of lv.lines) {
        ctx.moveTo(nx(seg[0]![0]), ny(seg[0]![1]));
        ctx.lineTo(nx(seg[1]![0]), ny(seg[1]![1]));
      }
      ctx.stroke();
      // label on the longest segment of the level, with a page-coloured halo so it reads over the field
      let best: [number, number][] | null = null;
      let bestLen = -1;
      for (const seg of lv.lines) {
        const len = Math.hypot(seg[1]![0] - seg[0]![0], seg[1]![1] - seg[0]![1]);
        if (len > bestLen) {
          bestLen = len;
          best = seg;
        }
      }
      if (best) {
        const mx = (nx(best[0]![0]) + nx(best[1]![0])) / 2;
        const my = (ny(best[0]![1]) + ny(best[1]![1])) / 2;
        const text = `${Math.round(lv.level * 10) / 10}`;
        ctx.font = fontData;
        ctx.textAlign = 'center';
        ctx.strokeStyle = c.surfacePage;
        ctx.lineWidth = 3;
        ctx.strokeText(text, mx, my - 2);
        ctx.fillStyle = c.inkMuted;
        ctx.fillText(text, mx, my - 2);
      }
    }
  }

  // --- wind arrows: a node grid over the field; direction from IDW of u/v, size and alpha by speed
  const moving = sites.filter((s) => s.speedMs != null && s.speedMs > 0);
  if (moving.length > 0) {
    const uSites: SiteSample[] = moving.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, value: -s.speedMs! * Math.sin(s.dirFromRad!) }));
    const vSites: SiteSample[] = moving.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, value: -s.speedMs! * Math.cos(s.dirFromRad!) }));
    const refSpeed = Math.max(4, ...moving.map((s) => s.speedMs!));
    const arrowCols = Math.min(9, Math.max(3, grid.cols - 1));
    const arrowRows = Math.min(7, Math.max(3, grid.rows - 1));
    const [inkR, inkG, inkB] = toRgb(c.ink);
    ctx.lineCap = 'round';
    for (let i = 0; i < arrowCols; i++) {
      for (let j = 0; j < arrowRows; j++) {
        const colFrac = (i + 0.5) / arrowCols;
        const rowFrac = (j + 0.5) / arrowRows;
        const lat = bounds.maxLat - (bounds.maxLat - bounds.minLat) * rowFrac;
        const lon = bounds.minLon + (bounds.maxLon - bounds.minLon) * colFrac;
        const u = idwAtPoint(uSites, lat, lon);
        const v = idwAtPoint(vSites, lat, lon);
        if (u == null || v == null) continue;
        const speed = Math.hypot(u, v);
        if (speed < 0.15) continue;
        const f = Math.min(1, speed / refSpeed);
        const len = 5 + 11 * f;
        const ux = u / speed;
        const uy = -v / speed; // screen y grows downward, north is up
        const cxp = colFrac * width;
        const cyp = rowFrac * heightPx;
        const x0 = cxp - (ux * len) / 2;
        const y0 = cyp - (uy * len) / 2;
        const x1 = cxp + (ux * len) / 2;
        const y1 = cyp + (uy * len) / 2;
        ctx.strokeStyle = `rgba(${inkR},${inkG},${inkB},${(0.3 + 0.6 * f).toFixed(3)})`;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        const ah = 3 + 2 * f;
        const px = -uy;
        const py = ux;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ux * ah + px * ah * 0.55, y1 - uy * ah + py * ah * 0.55);
        ctx.lineTo(x1 - ux * ah - px * ah * 0.55, y1 - uy * ah - py * ah * 0.55);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // --- site markers: value label, and a wind barb for the site's own wind
  ctx.font = fontData;
  for (const s of sites) {
    const [x, y] = project(s.lon, s.lat);
    const sample = grid.sites.find((g) => g.id === s.id);
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = sample?.value == null ? c.stale : c.ink;
    ctx.fill();
    ctx.strokeStyle = c.surfacePage;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const valueText = sample?.value == null ? '—' : fmtMapValue(map.variable, sample.value, map.variable === 'rainfall_mm' ? 1 : 0);
    const text = `${s.id} ${valueText}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = c.ink;
    ctx.strokeStyle = c.surfacePage;
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y - 7);
    ctx.fillText(text, x, y - 7);
    if (s.speedMs != null && s.dirFromRad != null) {
      drawBarb(ctx, x + 9, y + 2, s.dirFromRad, barbClassesFor(s.speedMs), c.ink);
    }
  }
}

// --------------------------------------------------------------- component
export function WeatherMap({
  map,
  geojson,
  sites,
  lightning,
  limits,
  variable,
  onVariable,
  mapTs,
  onScrub,
  scrubMin,
  scrubMax,
  scrubStep,
  width = 640,
  label,
}: {
  map: LwmMapDTO | null;
  geojson: unknown | null;
  /** The network snapshot sites — their latest wind feeds the arrows and the barbs. */
  sites: LwmSiteDTO[];
  /** Strikes for the field time (the page fetches these for the replayed frame). */
  lightning: LwmStrike[];
  limits: LwmLimits | null;
  variable: string;
  onVariable: (v: string) => void;
  /** Scrub time the page is showing (null = follow the sim clock). */
  mapTs: number | null;
  onScrub: (ts: number | null) => void;
  scrubMin: number;
  scrubMax: number;
  scrubStep: number;
  width?: number;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const c = useThemeColors();
  const [measured, setMeasured] = useState(width);
  const [lapseOn, setLapseOn] = useState(false);
  const [frames, setFrames] = useState<(LwmMapDTO | null)[]>([]);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  // fill the card: the canvas follows the container width, aspect kept from the geographic bounds
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && Math.abs(w - measured) > 6) setMeasured(Math.round(Math.min(1160, Math.max(320, w))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measured]);

  const siteVectors = useMemo(() => (map && map.grid?.sites?.length ? buildSiteVectors(map.grid.sites, sites) : []), [map, sites]);
  const siteLatLng = useMemo(() => {
    const m = new Map<string, { lat: number; lon: number }>();
    for (const s of sites) if (s.position && Number.isFinite(s.position.lat) && Number.isFinite(s.position.lon)) m.set(s.id, s.position);
    for (const v of siteVectors) if (!m.has(v.id)) m.set(v.id, { lat: v.lat, lon: v.lon });
    return m;
  }, [sites, siteVectors]);
  const mapCenter = useMemo(() => {
    if (siteLatLng.size === 0) return null;
    let lat = 0;
    let lon = 0;
    for (const p of siteLatLng.values()) {
      lat += p.lat;
      lon += p.lon;
    }
    return { lat: lat / siteLatLng.size, lon: lon / siteLatLng.size };
  }, [siteLatLng]);

  // --- time-lapse keyframes: 13 fields over the last hour, ending at the frame the map shows (replay-aware)
  const lapseAnchor = mapTs ?? map?.ts ?? null;
  const [lapseTick, setLapseTick] = useState(0);
  useEffect(() => {
    if (!lapseOn || lapseAnchor == null) return;
    const end = mapTs == null ? Math.floor(lapseAnchor / 60_000) * 60_000 : lapseAnchor;
    const times = timeLapseTimes(end, LAPSE_FRAMES, HOUR_MS);
    const ac = new AbortController();
    let alive = true;
    void Promise.all(times.map((t) => fetchLwmMap(variable, t, { signal: ac.signal }).catch(() => null))).then((fs) => {
      if (!alive) return;
      setFrames(fs);
      setFrame(fs.length - 1);
    });
    return () => {
      alive = false;
      ac.abort();
    };
  }, [lapseOn, lapseAnchor, variable, mapTs, lapseTick]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const id = setInterval(() => {
      setFrame((f) => {
        if (f >= frames.length - 1) {
          setPlaying(false);
          return f;
        }
        return f + 1;
      });
    }, LAPSE_STEP_MS);
    return () => clearInterval(id);
  }, [playing, frames.length]);

  const shown = lapseOn ? (frames[frame] ?? map) : map;
  const shownTs = lapseOn ? (frames[frame]?.ts ?? shown?.ts ?? null) : (map?.ts ?? null);
  const lapseAtLive = frame >= frames.length - 1;

  // redraw only when the data, the shown frame, the theme or the size change — never on a timer
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!shown || !shown.grid || shown.grid.values.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const heightPx = heightFor(shown.bounds, measured);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(measured * dpr);
    canvas.height = Math.round(heightPx * dpr);
    canvas.style.width = `${measured}px`;
    canvas.style.height = `${heightPx}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawField(ctx, {
      map: shown,
      geojson,
      sites: siteVectors,
      lightning: {
        strikes: lightning,
        siteById: siteLatLng,
        center: mapCenter,
        alertKm: limits?.lightningMaxKm ?? 10,
        anchorTs: shown.ts,
      },
      width: measured,
      heightPx,
      c,
    });
  }, [shown, geojson, siteVectors, lightning, siteLatLng, mapCenter, limits, measured, c]);

  const legendStops = sequentialStops(c)
    .map((s, i, all) => `${rgbCss(s)} ${(i / (all.length - 1)) * 100}%`)
    .join(', ');

  return (
    <div className="weather-map" ref={hostRef}>
      <div className="row gap" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
        <div className="seg" role="group" aria-label="Map variable">
          {VARIABLE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={variable === opt.id ? 'on' : ''}
              onClick={() => onVariable(opt.id)}
              aria-pressed={variable === opt.id}
              title={opt.label}
            >
              <VariableIcon id={opt.id} /> {opt.label}
            </button>
          ))}
        </div>
        <span className="muted small">
          arrows: interpolated airflow {lapseOn ? '' : '· click Time-lapse to watch the last hour'}
        </span>
      </div>

      <canvas
        ref={ref}
        role="img"
        aria-label={`${label}. Wind arrows interpolated from the site u/v components; isobars where pressure is selected.`}
        style={{ maxWidth: '100%', height: 'auto', borderRadius: 0, border: '1px solid var(--line)' }}
      />

      {shown && shown.min != null && shown.max != null && (
        <div className="map-legend">
          <span className="arl-num">{fmtMapValue(shown.variable, shown.min, 1)}</span>
          <span className="map-ramp" style={{ background: `linear-gradient(90deg, ${legendStops})` }} aria-hidden="true" />
          <span className="arl-num">{fmtMapValue(shown.variable, shown.max, 1)}</span>
          <span className="muted small">{shown.variable === 'temperature_k' || shown.variable === 'dew_point_k' ? '' : shown.unit}</span>
          {shown.variable === 'pressure_hpa' && <span className="muted small">isobars every {isobarStep((shown.max ?? 0) - (shown.min ?? 0))} hPa</span>}
        </div>
      )}

      <div className="row gap" style={{ flexWrap: 'wrap', alignItems: 'center', marginTop: 'var(--space-2)' }}>
        <button
          type="button"
          className="arl-btn"
          onClick={() => {
            if (lapseOn) {
              setLapseOn(false);
              setPlaying(false);
            } else {
              setLapseOn(true);
              setLapseTick((t) => t + 1); // re-anchor the keyframes at "now" when re-opened while live
              setPlaying(false);
            }
          }}
          aria-pressed={lapseOn}
        >
          {lapseOn ? 'Hide time-lapse' : 'Time-lapse'}
        </button>
        {lapseOn && (
          <>
            <button
              type="button"
              className="arl-btn"
              onClick={() => setPlaying((p) => !p)}
              disabled={playing || reduced || frames.length === 0}
              title={reduced ? 'Motion is reduced in your system settings; scrub with the slider instead' : undefined}
            >
              {playing ? 'Playing' : 'Play last hour'}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1)}
              step={1}
              value={frame}
              disabled={frames.length === 0}
              onChange={(e) => {
                setPlaying(false);
                setFrame(Number(e.target.value));
              }}
              aria-label="Time-lapse frame"
              style={{ flex: 1, minWidth: 120, accentColor: 'var(--accent)' }}
            />
            <span className="arl-num small" style={{ color: 'var(--ink-muted)' }}>
              {lapseAtLive ? `live edge ${fmtTime(shownTs)}` : fmtTime(shownTs)}
            </span>
          </>
        )}
      </div>

      <div className="row gap map-scrub" style={{ marginTop: lapseOn ? 0 : 'var(--space-2)' }}>
        <input
          type="range"
          min={scrubMin}
          max={scrubMax}
          step={scrubStep}
          value={mapTs ?? scrubMax}
          disabled={scrubMax <= scrubMin}
          onChange={(e) => {
            setLapseOn(false);
            setPlaying(false);
            onScrub(Number(e.target.value));
          }}
          aria-label="Map time"
        />
        <button type="button" className="arl-btn" onClick={() => onScrub(null)} disabled={mapTs == null}>
          Live
        </button>
      </div>
    </div>
  );
}
