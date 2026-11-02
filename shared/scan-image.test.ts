import { describe, expect, it } from 'vitest';
import {
  bandOf,
  buildCleanImage,
  buildRawImage,
  correlation,
  emptyColumns,
  percentileSorted,
  pixelCentre,
  sampleToPixel,
} from './scan-image';
import type { ScanSampleColumns } from './types';

const FOV = 0.01;

/** Builds columns from [dish, dra, ddec, signal, snr, fault] tuples. */
function cols(rows: [string, number, number, number, number | null, string | null][]): ScanSampleColumns {
  const c = emptyColumns();
  for (const [dish, ra, dec, s, snr, f] of rows) {
    let d = c.dishes.indexOf(dish);
    if (d < 0) d = c.dishes.push(dish) - 1;
    c.d.push(d);
    c.t.push(0);
    c.ra.push(ra);
    c.dec.push(dec);
    c.s.push(s);
    c.snr.push(snr);
    c.f.push(f);
  }
  return c;
}

/** Every pixel of an n×n grid once per dish, signal = fn(x, y). */
function fullScan(n: number, dishes: string[], fn: (x: number, y: number, dish: string) => number, snr = 10) {
  const rows: [string, number, number, number, number | null, string | null][] = [];
  for (const dish of dishes)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const [ra, dec] = pixelCentre(x, y, n, FOV);
        rows.push([dish, ra, dec, fn(x, y, dish), snr, 'none']);
      }
  return cols(rows);
}

describe('pixel mapping (spec §3.1)', () => {
  const n = 128;
  it('puts the pointing centre in the middle pixel', () => {
    expect(sampleToPixel(0, 0, n, FOV)).toEqual([64, 64]);
  });
  it('puts north (positive Δδ) at the top and positive Δα to the right', () => {
    expect(sampleToPixel(0, FOV * 0.499, n, FOV)[1]).toBe(0);
    expect(sampleToPixel(0, -FOV * 0.499, n, FOV)[1]).toBe(n - 1);
    expect(sampleToPixel(-FOV * 0.499, 0, n, FOV)[0]).toBe(0);
    expect(sampleToPixel(FOV * 0.499, 0, n, FOV)[0]).toBe(n - 1);
  });
  it('clamps offsets outside the field to the edge', () => {
    expect(sampleToPixel(FOV, -FOV, n, FOV)).toEqual([n - 1, n - 1]);
    expect(sampleToPixel(-FOV, FOV, n, FOV)).toEqual([0, 0]);
  });
  it('round-trips pixel centres', () => {
    for (const [x, y] of [
      [0, 0],
      [5, 100],
      [127, 127],
      [64, 3],
    ] as const) {
      const [ra, dec] = pixelCentre(x, y, n, FOV);
      expect(sampleToPixel(ra, dec, n, FOV)).toEqual([x, y]);
    }
  });
});

describe('bandOf', () => {
  it('maps the observing bands (L 1–2, C 4–8, K 18–26 GHz)', () => {
    expect(bandOf(1.42e9)).toBe('L');
    expect(bandOf(6e9)).toBe('C');
    expect(bandOf(22e9)).toBe('K');
    expect(bandOf(null)).toBeNull();
  });
});

describe('percentileSorted', () => {
  it('interpolates within a sorted array', () => {
    expect(percentileSorted([0, 10], 50)).toBe(5);
    expect(percentileSorted([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentileSorted([1, 2, 3, 4, 5], 100)).toBe(5);
  });
});

describe('buildRawImage', () => {
  it('averages samples per pixel, scales min→max and leaves holes', () => {
    const c = cols([
      ['dish-001', 0, 0, 10, 10, 'none'],
      ['dish-002', 0, 0, 20, 10, 'none'],
      ['dish-001', -FOV * 0.49, FOV * 0.49, 0, 10, 'none'],
    ]);
    const img = buildRawImage(c, { gridSize: 4, fovRad: FOV });
    expect(img.values[2 * 4 + 2]).toBeCloseTo(1); // centre: mean 15 = max
    expect(img.values[0]).toBe(0); // top-left: min
    expect(img.stats.holes).toBe(14);
    expect(Number.isNaN(img.values[1]!)).toBe(true);
  });
});

describe('buildCleanImage', () => {
  const n = 8;
  const geom = { gridSize: n, fovRad: FOV };
  const gradient = (x: number) => 1 + x;

  it('drops receiver_fault / power_fault samples', () => {
    const c = fullScan(n, ['dish-001'], gradient);
    const bad = cols([['dish-009', 0, 0, 1000, 20, 'receiver_fault']]);
    for (const k of ['d', 't', 'ra', 'dec', 's', 'snr', 'f'] as const) (c[k] as unknown[]).push(...(bad[k] as unknown[]).map((v) => (k === 'd' ? 1 : v)));
    c.dishes.push('dish-009');
    const img = buildCleanImage(c, geom, { fillHoles: false });
    expect(img.stats.droppedFault).toBe(1);
    expect(img.stats.used).toBe(n * n);
  });

  it('drops low-SNR samples only where the pixel also has a good sample', () => {
    const [ra, dec] = pixelCentre(1, 1, n, FOV);
    const [ra2, dec2] = pixelCentre(6, 6, n, FOV);
    const c = cols([
      ['dish-001', ra, dec, 5, 8, 'none'],
      ['dish-002', ra, dec, 50, 1, 'none'], // dropped: pixel has a good sample
      ['dish-001', ra2, dec2, 2, 1, 'none'], // kept: faint pixel, every sample is low-SNR
      ['dish-002', ra2, dec2, 3, 0.5, 'none'],
    ]);
    const img = buildCleanImage(c, geom, { minSnrDb: 3, fillHoles: false });
    expect(img.stats.droppedSnr).toBe(1);
    expect(img.stats.lowSnrPixels).toBe(1);
    expect(img.counts[1 * n + 1]).toBe(1);
    expect(img.counts[6 * n + 6]).toBe(2);
  });

  it('normalises per-dish gain so a hot dish does not stripe the image', () => {
    // dish-002 reads 3× too high on the right half; after gain correction both halves follow the same gradient
    const c = fullScan(n, ['dish-001', 'dish-002'], (x, _y, dish) => gradient(x) * (dish === 'dish-002' ? 3 : 1));
    const img = buildCleanImage(c, geom, { fillHoles: false, lowPct: 0, highPct: 100, backgroundPct: 0 });
    expect(img.stats.gainMax / img.stats.gainMin).toBeCloseTo(3, 1);
    const row = Array.from(img.values.slice(0, n));
    for (let x = 1; x < n; x++) expect(row[x]!).toBeGreaterThan(row[x - 1]!); // monotonic gradient survives
  });

  it('uses the per-pixel median, robust to one outlier', () => {
    const c = fullScan(n, ['dish-001', 'dish-002', 'dish-003'], () => 1);
    const [ra, dec] = pixelCentre(3, 3, n, FOV);
    const out = cols([['dish-004', ra, dec, 1e6, 20, 'none']]);
    c.dishes.push('dish-004');
    for (const k of ['t', 'ra', 'dec', 's', 'snr', 'f'] as const) (c[k] as unknown[]).push(...(out[k] as unknown[]));
    c.d.push(3);
    const img = buildCleanImage(c, geom, { fillHoles: false });
    expect(img.counts[3 * n + 3]).toBe(4);
    // flat field → every pixel equal (median ignores the 1e6 sample), so scaling maps all to 0
    expect(new Set(Array.from(img.values)).size).toBe(1);
  });

  it('fills holes from neighbours and marks them', () => {
    const rows: [string, number, number, number, number | null, string | null][] = [];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (x === 4 && y === 4) continue;
        const [ra, dec] = pixelCentre(x, y, n, FOV);
        rows.push(['dish-001', ra, dec, 1 + x + y, 10, 'none']);
      }
    const filled = buildCleanImage(cols(rows), geom, { fillHoles: true });
    expect(filled.stats.holes).toBe(1);
    expect(filled.filled[4 * n + 4]).toBe(1);
    expect(Number.isFinite(filled.values[4 * n + 4]!)).toBe(true);
    const open = buildCleanImage(cols(rows), geom, { fillHoles: false });
    expect(Number.isNaN(open.values[4 * n + 4]!)).toBe(true);
  });

  it('produces display values in 0..1', () => {
    const img = buildCleanImage(fullScan(n, ['dish-001'], (x, y) => Math.sin(x) + y), geom);
    for (const v of img.values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('correlation', () => {
  it('is 1 for identical, −1 for inverted, and ignores NaN pixels', () => {
    const a = [0, 1, 2, 3, NaN];
    expect(correlation(a, [0, 1, 2, 3, 9])).toBeCloseTo(1);
    expect(correlation(a, [3, 2, 1, 0, 9])).toBeCloseTo(-1);
    expect(Number.isNaN(correlation([1, 1, 1], [1, 2, 3]))).toBe(true);
  });
});
