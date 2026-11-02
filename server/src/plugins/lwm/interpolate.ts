// Inverse-distance-weighted interpolation of one weather variable across the five sites, on the grid
// the web map colour-fills. Done server-side so replay can scrub it to any buffered time (the grid is
// built from whatever samples were latest at the requested ts) and so it is unit-testable. The client
// only projects lat/lon to canvas pixels — no map tiles, just the arl.geojson outline underneath.
import type { WeatherHistoryRow } from '../../db/lwm.js';

/** One site's reading of the interpolated variable; value null means the site cannot contribute. */
export interface SiteSample {
  id: string;
  lat: number;
  lon: number;
  value: number | null;
}

/** Map extent in degrees; the grid and the geojson are projected onto the same box. */
export interface GridBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

export interface IdwGrid {
  cols: number;
  rows: number;
  bounds: GridBounds;
  /** Row-major values (row 0 = the north edge), null where no site had a reading to interpolate. */
  values: (number | null)[];
  min: number | null;
  max: number | null;
  /** The sites and their exact readings, so the client can mark them on the field. */
  sites: SiteSample[];
}

const KM_PER_DEG_LAT = 110.574;
/** A grid point this close to a site (km) just takes the site's value: avoids the 1/0 pole. */
const SNAP_KM = 1e-6;

/** Planar distance in km, good to well under a metre across a few-kilometre campus. */
function distKm(lat: number, lon: number, sLat: number, sLon: number): number {
  const cosLat = Math.cos((((lat + sLat) / 2) * Math.PI) / 180);
  const dx = (lon - sLon) * cosLat * KM_PER_DEG_LAT;
  const dy = (lat - sLat) * KM_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * IDW over the contributing sites: value(p) = Σ(wᵢ·vᵢ)/Σwᵢ with wᵢ = 1/dᵢ^power. A single contributor
 * gives a flat field at its value (the weights cancel), which is the honest answer with one reading.
 */
export function idwGrid(sites: SiteSample[], bounds: GridBounds, cols: number, rows: number, power = 2): IdwGrid {
  const contributors = sites.filter((s) => s.value !== null && Number.isFinite(s.value) && Number.isFinite(s.lat) && Number.isFinite(s.lon));
  const values: (number | null)[] = new Array(Math.max(0, cols) * Math.max(0, rows)).fill(null);
  let min: number | null = null;
  let max: number | null = null;

  if (contributors.length > 0 && cols > 0 && rows > 0) {
    const latSpan = bounds.maxLat - bounds.minLat;
    const lonSpan = bounds.maxLon - bounds.minLon;
    for (let r = 0; r < rows; r++) {
      const lat = rows === 1 ? bounds.maxLat : bounds.maxLat - (latSpan * r) / (rows - 1);
      for (let c = 0; c < cols; c++) {
        const lon = cols === 1 ? bounds.minLon : bounds.minLon + (lonSpan * c) / (cols - 1);
        let wsum = 0;
        let vsum = 0;
        let snap: number | null = null;
        for (const s of contributors) {
          const d = distKm(lat, lon, s.lat, s.lon);
          if (d < SNAP_KM) {
            snap = s.value;
            break;
          }
          const w = 1 / Math.pow(d, power);
          wsum += w;
          vsum += w * (s.value as number);
        }
        const v = snap !== null ? snap : wsum > 0 ? vsum / wsum : null;
        values[r * cols + c] = v;
        if (v !== null) {
          if (min === null || v < min) min = v;
          if (max === null || v > max) max = v;
        }
      }
    }
  }

  return {
    cols,
    rows,
    bounds,
    values,
    min,
    max,
    sites: sites.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, value: s.value })),
  };
}

/** Bounding box of every coordinate in a GeoJSON FeatureCollection (or a lone geometry). */
export function boundsFromGeoJson(geojson: unknown): GridBounds | null {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      const lon = node[0] as number;
      const lat = node[1] as number;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const x of node) walk(x);
  };
  const gj = geojson as { features?: { geometry?: { coordinates?: unknown } }[]; coordinates?: unknown };
  if (Array.isArray(gj?.features)) for (const f of gj.features) walk(f.geometry?.coordinates);
  else walk(gj?.coordinates);
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null;
  return { minLon, maxLon, minLat, maxLat };
}

/** Fallback extent from the site positions with a small margin, used when no geojson is available. */
export function boundsFromSites(sites: SiteSample[], marginDeg = 0.004): GridBounds | null {
  const pts = sites.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (pts.length === 0) return null;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const s of pts) {
    if (s.lon < minLon) minLon = s.lon;
    if (s.lon > maxLon) maxLon = s.lon;
    if (s.lat < minLat) minLat = s.lat;
    if (s.lat > maxLat) maxLat = s.lat;
  }
  return { minLon: minLon - marginDeg, maxLon: maxLon + marginDeg, minLat: minLat - marginDeg, maxLat: maxLat + marginDeg };
}

/**
 * Builds the per-site samples for one variable from the map rows (the latest sample per site at the
 * requested ts). `pick` reads the variable off a weather row; dew point and other derived variables
 * are passed in by the caller as a lookup so interpolate stays free of the model.
 */
export function siteSamples(rows: WeatherHistoryRow[], pick: (row: WeatherHistoryRow) => number | null, positions: Record<string, { lat: number; lon: number }>): SiteSample[] {
  return rows.map((r) => {
    const pos = positions[r.entity];
    return {
      id: r.entity,
      lat: pos?.lat ?? Number.NaN,
      lon: pos?.lon ?? Number.NaN,
      value: pick(r),
    };
  });
}
