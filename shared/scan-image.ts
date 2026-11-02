// Scan image reconstruction (RTA spec §3). Pure functions, shared by server (stored images, tests)
// and browser (live build-up). No dependencies.
import type { Band, ScanSampleColumns } from './types';

export interface ScanGeometry {
  gridSize: number; // N
  fovRad: number; // theta
}

export interface CleanOptions {
  /** rta scan.min_snr_db from the ARL API alert limits. */
  minSnrDb: number;
  /** Samples carrying one of these fault codes are dropped. */
  faultCodes: readonly string[];
  backgroundPct: number;
  lowPct: number;
  highPct: number;
  fillHoles: boolean;
}

export const DEFAULT_CLEAN: CleanOptions = {
  minSnrDb: 3,
  faultCodes: ['receiver_fault', 'power_fault'],
  backgroundPct: 5,
  lowPct: 1,
  highPct: 99,
  fillHoles: true,
};

export interface ImageStats {
  input: number;
  droppedFault: number;
  droppedSnr: number;
  lowSnrPixels: number; // pixels where every sample was below the limit (kept, see buildCleanImage)
  used: number;
  holes: number;
  filled: number;
  gainMin: number;
  gainMax: number;
  background: number;
  lo: number;
  hi: number;
  dishes: number;
}

export interface ScanImage {
  n: number;
  /** Display value 0..1 per pixel, row-major (y*n + x). NaN = hole (not filled). */
  values: Float32Array;
  /** 1 where no usable sample landed (before hole filling). */
  holes: Uint8Array;
  /** 1 where the value was filled from neighbours. */
  filled: Uint8Array;
  /** Samples that contributed to each pixel. */
  counts: Uint16Array;
  stats: ImageStats;
}

/** Spec §3.1: x = floor(N(Δα/θ + 1/2)), y = floor(N(1/2 − Δδ/θ)), clamped to 0..N−1 (north up). */
export function sampleToPixel(dra: number, ddec: number, n: number, fov: number): [number, number] {
  const x = Math.floor(n * (dra / fov + 0.5));
  const y = Math.floor(n * (0.5 - ddec / fov));
  return [clamp(x, 0, n - 1), clamp(y, 0, n - 1)];
}

/** Inverse of sampleToPixel: offsets of the centre of pixel (x, y). */
export function pixelCentre(x: number, y: number, n: number, fov: number): [number, number] {
  return [((x + 0.5) / n - 0.5) * fov, (0.5 - (y + 0.5) / n) * fov];
}

export function bandOf(hz: number | null | undefined): Band | null {
  if (hz == null || !Number.isFinite(hz)) return null;
  const g = hz / 1e9;
  if (g >= 1 && g <= 2) return 'L';
  if (g >= 4 && g <= 8) return 'C';
  if (g >= 18 && g <= 26) return 'K';
  const centres: [Band, number][] = [
    ['L', 1.5],
    ['C', 6],
    ['K', 22],
  ];
  let best: Band = 'L';
  let bestD = Infinity;
  for (const [b, c] of centres) {
    const d = Math.abs(g - c);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Linear-interpolated percentile of an ascending-sorted array. */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const len = sorted.length;
  if (len === 0) return NaN;
  if (len === 1) return sorted[0]!;
  const pos = (clamp(p, 0, 100) / 100) * (len - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (pos - lo);
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isUsable(cols: ScanSampleColumns, i: number): boolean {
  return Number.isFinite(cols.ra[i]) && Number.isFinite(cols.dec[i]) && Number.isFinite(cols.s[i]);
}

function emptyStats(input: number): ImageStats {
  return {
    input,
    droppedFault: 0,
    droppedSnr: 0,
    lowSnrPixels: 0,
    used: 0,
    holes: 0,
    filled: 0,
    gainMin: 1,
    gainMax: 1,
    background: 0,
    lo: 0,
    hi: 0,
    dishes: 0,
  };
}

/** Spec §3.2 as written: mean signal per pixel, linear min→max scale, holes left as NaN. */
export function buildRawImage(cols: ScanSampleColumns, geom: ScanGeometry): ScanImage {
  const n = geom.gridSize;
  const sum = new Float64Array(n * n);
  const counts = new Uint16Array(n * n);
  const stats = emptyStats(cols.s.length);
  const dishSeen = new Set<number>();
  for (let i = 0; i < cols.s.length; i++) {
    if (!isUsable(cols, i)) continue;
    const [x, y] = sampleToPixel(cols.ra[i]!, cols.dec[i]!, n, geom.fovRad);
    const p = y * n + x;
    sum[p] = sum[p]! + cols.s[i]!;
    counts[p] = counts[p]! + 1;
    stats.used++;
    dishSeen.add(cols.d[i]!);
  }
  const values = new Float32Array(n * n).fill(NaN);
  const holes = new Uint8Array(n * n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let p = 0; p < n * n; p++) {
    if (counts[p] === 0) {
      holes[p] = 1;
      stats.holes++;
      continue;
    }
    const m = sum[p]! / counts[p]!;
    values[p] = m;
    if (m < lo) lo = m;
    if (m > hi) hi = m;
  }
  const span = hi - lo;
  for (let p = 0; p < n * n; p++) {
    if (holes[p]) continue;
    values[p] = span > 0 ? (values[p]! - lo) / span : 0;
  }
  stats.lo = Number.isFinite(lo) ? lo : 0;
  stats.hi = Number.isFinite(hi) ? hi : 0;
  stats.dishes = dishSeen.size;
  return { n, values, holes, filled: new Uint8Array(n * n), counts, stats };
}

/**
 * Clean-up pipeline (the scan data is deliberately noisy):
 *  1. drop samples whose fault_code is receiver_fault / power_fault;
 *  2. SNR: drop samples below minSnrDb — but only in pixels that have at least one sample at or above
 *     the limit. SNR tracks brightness, so on faint sky every sample is below the limit; a blanket cut
 *     would turn ~90% of the image into holes. Such pixels keep all samples (counted in lowSnrPixels);
 *  3. per-dish gain: divide by (dish median / global median);
 *  4. per-pixel MEDIAN of the remaining samples (robust to bright outliers from faulty dishes);
 *  5. subtract the background (backgroundPct percentile);
 *  6. scale lowPct..highPct percentile to 0..1;
 *  7. fill holes with the mean of their filled neighbours (marked in `filled`).
 */
export function buildCleanImage(
  cols: ScanSampleColumns,
  geom: ScanGeometry,
  options: Partial<CleanOptions> = {},
): ScanImage {
  const opt: CleanOptions = { ...DEFAULT_CLEAN, ...options };
  const n = geom.gridSize;
  const np = n * n;
  const total = cols.s.length;
  const stats = emptyStats(total);
  const faultSet = new Set(opt.faultCodes);

  // pixel index per sample, -1 = unusable / dropped
  const pix = new Int32Array(total).fill(-1);
  const bestSnr = new Float64Array(np).fill(-Infinity);
  for (let i = 0; i < total; i++) {
    if (!isUsable(cols, i)) continue;
    const f = cols.f[i];
    if (f != null && faultSet.has(f)) {
      stats.droppedFault++;
      continue;
    }
    const [x, y] = sampleToPixel(cols.ra[i]!, cols.dec[i]!, n, geom.fovRad);
    const p = y * n + x;
    pix[i] = p;
    const snr = cols.snr[i];
    if (snr != null && snr > bestSnr[p]!) bestSnr[p] = snr;
  }
  const lowSnrPixel = new Uint8Array(np);
  for (let i = 0; i < total; i++) {
    const p = pix[i]!;
    if (p < 0) continue;
    const snr = cols.snr[i];
    if (bestSnr[p]! < opt.minSnrDb) {
      lowSnrPixel[p] = 1;
      continue;
    }
    if (snr != null && snr < opt.minSnrDb) {
      pix[i] = -1;
      stats.droppedSnr++;
    }
  }
  for (let p = 0; p < np; p++) if (lowSnrPixel[p] && bestSnr[p]! > -Infinity) stats.lowSnrPixels++;

  // 3. per-dish gain
  const byDish = new Map<number, number[]>();
  const all: number[] = [];
  for (let i = 0; i < total; i++) {
    if (pix[i]! < 0) continue;
    const s = cols.s[i]!;
    all.push(s);
    const d = cols.d[i]!;
    let arr = byDish.get(d);
    if (!arr) byDish.set(d, (arr = []));
    arr.push(s);
  }
  stats.dishes = byDish.size;
  const globalMed = median(all);
  const gain = new Map<number, number>();
  let gMin = Infinity;
  let gMax = -Infinity;
  for (const [d, arr] of byDish) {
    let g = 1;
    if (globalMed > 0 && arr.length >= 10) {
      const m = median(arr);
      if (m > 0) g = clamp(m / globalMed, 0.25, 4);
    }
    gain.set(d, g);
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
  }
  stats.gainMin = Number.isFinite(gMin) ? gMin : 1;
  stats.gainMax = Number.isFinite(gMax) ? gMax : 1;

  // 4. per-pixel median (counting sort into buckets)
  const counts = new Uint16Array(np);
  for (let i = 0; i < total; i++) if (pix[i]! >= 0) counts[pix[i]!] = counts[pix[i]!]! + 1;
  const offsets = new Uint32Array(np + 1);
  for (let p = 0; p < np; p++) offsets[p + 1] = offsets[p]! + counts[p]!;
  const bucket = new Float64Array(offsets[np]!);
  const fillPos = offsets.slice(0, np);
  for (let i = 0; i < total; i++) {
    const p = pix[i]!;
    if (p < 0) continue;
    bucket[fillPos[p]!] = cols.s[i]! / (gain.get(cols.d[i]!) ?? 1);
    fillPos[p] = fillPos[p]! + 1;
    stats.used++;
  }
  const values = new Float32Array(np).fill(NaN);
  const holes = new Uint8Array(np);
  const present: number[] = [];
  for (let p = 0; p < np; p++) {
    const c = counts[p]!;
    if (c === 0) {
      holes[p] = 1;
      stats.holes++;
      continue;
    }
    const slice = Array.from(bucket.subarray(offsets[p]!, offsets[p + 1]!)).sort((a, b) => a - b);
    const mid = c >> 1;
    const m = c % 2 ? slice[mid]! : (slice[mid - 1]! + slice[mid]!) / 2;
    values[p] = m;
    present.push(m);
  }

  // 5 + 6. background and percentile scaling
  present.sort((a, b) => a - b);
  const bg = percentileSorted(present, opt.backgroundPct);
  const lo = percentileSorted(present, opt.lowPct) - bg;
  const hi = percentileSorted(present, opt.highPct) - bg;
  stats.background = Number.isFinite(bg) ? bg : 0;
  stats.lo = Number.isFinite(lo) ? lo : 0;
  stats.hi = Number.isFinite(hi) ? hi : 0;
  const span = hi - lo;
  for (let p = 0; p < np; p++) {
    if (holes[p]) continue;
    const v = values[p]! - bg;
    values[p] = span > 0 ? clamp((v - lo) / span, 0, 1) : 0;
  }

  // 7. fill holes from neighbours
  const filled = new Uint8Array(np);
  if (opt.fillHoles && stats.holes > 0 && stats.holes < np) {
    stats.filled = fillHoles(values, n, filled);
  }
  return { n, values, holes, filled, counts, stats };
}

/** Iteratively fills NaN pixels with the mean of their non-NaN 8-neighbours. Returns pixels filled. */
export function fillHoles(values: Float32Array, n: number, filled: Uint8Array): number {
  let total = 0;
  for (let pass = 0; pass < 2 * n; pass++) {
    const updates: [number, number][] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = y * n + x;
        if (!Number.isNaN(values[p]!)) continue;
        let sum = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= n) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx === 0 && dy === 0) || xx < 0 || xx >= n) continue;
            const v = values[yy * n + xx]!;
            if (!Number.isNaN(v)) {
              sum += v;
              c++;
            }
          }
        }
        if (c > 0) updates.push([p, sum / c]);
      }
    }
    if (updates.length === 0) break;
    for (const [p, v] of updates) {
      values[p] = v;
      filled[p] = 1;
    }
    total += updates.length;
  }
  return total;
}

/** Pearson correlation of two equally sized images, ignoring NaN pixels in either. */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let n = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    n++;
    sa += x;
    sb += y;
  }
  if (n < 2) return NaN;
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    cov += (x - ma) * (y - mb);
    va += (x - ma) ** 2;
    vb += (y - mb) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
}

export function emptyColumns(): ScanSampleColumns {
  return { dishes: [], d: [], t: [], ra: [], dec: [], s: [], snr: [], f: [] };
}

/** Appends `src` to `dst`, remapping dish indices. Mutates and returns dst. */
export function appendColumns(dst: ScanSampleColumns, src: ScanSampleColumns): ScanSampleColumns {
  const map = src.dishes.map((id) => {
    let i = dst.dishes.indexOf(id);
    if (i < 0) i = dst.dishes.push(id) - 1;
    return i;
  });
  for (let i = 0; i < src.s.length; i++) {
    dst.d.push(map[src.d[i]!]!);
    dst.t.push(src.t[i]!);
    dst.ra.push(src.ra[i]!);
    dst.dec.push(src.dec[i]!);
    dst.s.push(src.s[i]!);
    dst.snr.push(src.snr[i] ?? null);
    dst.f.push(src.f[i] ?? null);
  }
  return dst;
}
