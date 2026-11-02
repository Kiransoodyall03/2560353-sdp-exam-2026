// IDW weather field on a canvas: the server sends a row-major grid (row 0 = north) plus the bounds, so
// the client only projects lat/lon to pixels — no map tiles, just the arl.geojson outline underneath and
// a marker per site. The field is drawn to a cols×rows offscreen canvas then scaled up with smoothing so
// the interpolation looks continuous. Works identically in replay: the page passes a historical ts and the
// server returns whatever samples were latest then.
import { useEffect, useRef } from 'react';
import { cssVar, rampAt, rgbCss, sequentialStops, useThemeColors } from '../../lib/colors';
import type { GridBounds, IdwGrid, LwmMapDTO } from '../../lib/lwm';

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
  const c = useThemeColors();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!map || !map.grid || map.grid.values.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const grid: IdwGrid = map.grid;
    const bounds = map.bounds;
    const heightPx = heightFor(bounds, width);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(heightPx * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${heightPx}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, heightPx);
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

    // --- campus outline on top of the field
    if (geojson) {
      ctx.strokeStyle = c.lineStrong;
      ctx.lineWidth = 1.25;
      const gj = geojson as { features?: { geometry?: { coordinates?: unknown } }[]; coordinates?: unknown };
      if (Array.isArray(gj.features)) for (const f of gj.features) strokeGeo(ctx, f.geometry?.coordinates, project);
      else strokeGeo(ctx, gj.coordinates, project);
    }

    // --- site markers with their exact reading; neutral unless the reading is missing
    ctx.font = `10px ${cssVar('--font-data') || 'sans-serif'}`;
    ctx.textAlign = 'center';
    for (const s of grid.sites) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      const [x, y] = project(s.lon, s.lat);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = s.value == null ? c.stale : c.ink;
      ctx.fill();
      ctx.strokeStyle = c.surfacePage;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = c.ink;
      ctx.strokeStyle = c.surfacePage;
      ctx.lineWidth = 3;
      const text = `${s.id} ${s.value == null ? '—' : Math.round(s.value)}`;
      ctx.strokeText(text, x, y - 7);
      ctx.fillText(text, x, y - 7);
    }
  }, [map, geojson, width, c]);

  const legendStops = sequentialStops(c)
    .map((s, i, all) => `${rgbCss(s)} ${(i / (all.length - 1)) * 100}%`)
    .join(', ');

  return (
    <div className="weather-map">
      <canvas
        ref={ref}
        role="img"
        aria-label={label}
        style={{ maxWidth: '100%', height: 'auto', borderRadius: 0, border: '1px solid var(--line)' }}
      />
      {map && map.min != null && map.max != null && (
        <div className="map-legend">
          <span className="arl-num">{map.min.toFixed(1)}</span>
          <span className="map-ramp" style={{ background: `linear-gradient(90deg, ${legendStops})` }} aria-hidden="true" />
          <span className="arl-num">{map.max.toFixed(1)}</span>
          <span className="muted small">{map.unit}</span>
        </div>
      )}
    </div>
  );
}
