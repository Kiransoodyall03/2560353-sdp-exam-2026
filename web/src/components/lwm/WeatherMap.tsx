// IDW weather field on a canvas: the server sends a row-major grid (row 0 = north) plus the bounds, so
// the client only projects lat/lon to pixels — no map tiles, just the arl.geojson outline underneath and
// a marker per site. The field is drawn to a cols×rows offscreen canvas then scaled up with smoothing so
// the interpolation looks continuous. Works identically in replay: the page passes a historical ts and the
// server returns whatever samples were latest then.
import { useEffect, useRef } from 'react';
import type { GridBounds, IdwGrid, LwmMapDTO } from '../../lib/lwm';

/** Viridis-like sequential ramp; t is 0..1. */
const STOPS: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

function ramp(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const KM_PER_DEG_LAT = 110.574;

/** A linear equirectangular projection that keeps the campus shape honest (lon scaled by cos lat). */
function makeProjector(bounds: GridBounds, widthPx: number, heightPx: number) {
  const lonSpan = bounds.maxLon - bounds.minLon || 1e-9;
  const latSpan = bounds.maxLat - bounds.minLat || 1e-9;
  return (lon: number, lat: number): [number, number] => {
    const x = ((lon - bounds.minLon) / lonSpan) * widthPx;
    const y = ((bounds.maxLat - lat) / latSpan) * heightPx;
    return [x, y];
  };
}

/** Canvas height that matches the geographic aspect ratio of the bounds for a given width. */
function heightFor(bounds: GridBounds, widthPx: number): number {
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

export function WeatherMap({
  map,
  geojson,
  width = 640,
  label,
}: {
  map: LwmMapDTO | null;
  geojson: unknown | null;
  width?: number;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    if (!map || !map.grid || map.grid.values.length === 0) {
      ctx.clearRect(0, 0, c.width, c.height);
      return;
    }
    const grid: IdwGrid = map.grid;
    const bounds = map.bounds;
    const heightPx = heightFor(bounds, width);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(width * dpr);
    c.height = Math.round(heightPx * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${heightPx}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, heightPx);
    ctx.fillStyle = '#0b0f14';
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
        const [r, g, b] = ramp((v - lo) / span);
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

    // --- campus outline on top of the field
    if (geojson) {
      ctx.strokeStyle = 'rgba(223, 230, 238, 0.75)';
      ctx.lineWidth = 1.25;
      const gj = geojson as { features?: { geometry?: { coordinates?: unknown } }[]; coordinates?: unknown };
      if (Array.isArray(gj.features)) for (const f of gj.features) strokeGeo(ctx, f.geometry?.coordinates, project);
      else strokeGeo(ctx, gj.coordinates, project);
    }

    // --- site markers with their exact reading
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const s of grid.sites) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      const [x, y] = project(s.lon, s.lat);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = s.value == null ? '#6b7787' : '#0d1117';
      ctx.fill();
      ctx.strokeStyle = '#dfe6ee';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#dfe6ee';
      ctx.strokeStyle = 'rgba(13, 17, 23, 0.9)';
      ctx.lineWidth = 3;
      const text = `${s.id} ${s.value == null ? '—' : Math.round(s.value)}`;
      ctx.strokeText(text, x, y - 7);
      ctx.fillText(text, x, y - 7);
    }
  }, [map, geojson, width]);

  const legendStops = STOPS.map((s, i) => `${`rgb(${s[0]},${s[1]},${s[2]})`} ${(i / (STOPS.length - 1)) * 100}%`).join(', ');

  return (
    <div className="weather-map">
      <canvas ref={ref} role="img" aria-label={label} style={{ maxWidth: '100%', height: 'auto', borderRadius: 6, border: '1px solid var(--line)' }} />
      {map && map.min != null && map.max != null && (
        <div className="map-legend">
          <span className="mono">{map.min.toFixed(1)}</span>
          <span className="map-ramp" style={{ background: `linear-gradient(90deg, ${legendStops})` }} aria-hidden="true" />
          <span className="mono">{map.max.toFixed(1)}</span>
          <span className="muted small">{map.unit}</span>
        </div>
      )}
    </div>
  );
}
