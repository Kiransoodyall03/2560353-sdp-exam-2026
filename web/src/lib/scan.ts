// Scan image helpers for the browser: server-stored images, live client-side build-up from SSE samples
// (same shared pipeline as the server), and reference-image correlation.
import { useEffect, useMemo, useState } from 'react';
import { correlation, type ImageStats, type ScanImage } from '../../../shared/scan-image';
import type { GridImage } from '../components/ScanCanvas';
import { loadReference } from '../components/ScanCanvas';
import { api, errorText } from './api';

export type ImageMode = 'raw' | 'clean';

export interface ServerImage extends GridImage {
  mode: ImageMode;
  values: (number | null)[];
  holes: number[];
  filled: number[];
  stats: ImageStats;
  stored: boolean;
  minSnrDb: number | null;
}

export interface ImageParams {
  mode: ImageMode;
  minSnr?: number | null;
  fill?: boolean;
}

export function useServerImage(
  scanId: string | null,
  p: ImageParams,
  version: unknown = null,
): { image: ServerImage | null; error: string | null; loading: boolean } {
  const [image, setImage] = useState<ServerImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!scanId) return;
    const ctl = new AbortController();
    const q = new URLSearchParams({ mode: p.mode, fill: p.fill === false ? '0' : '1' });
    if (p.mode === 'clean' && p.minSnr != null) q.set('minSnr', String(p.minSnr));
    setLoading(true);
    api
      .get<ServerImage>(`/api/rta/scans/${encodeURIComponent(scanId)}/image?${q}`, { signal: ctl.signal })
      .then((img) => {
        setImage(img);
        setError(null);
      })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') setError(errorText(err));
      })
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [scanId, p.mode, p.minSnr, p.fill, version]);
  return { image, error, loading };
}

export function scanImageToGrid(img: ScanImage): GridImage & { stats: ImageStats } {
  const holes: number[] = [];
  const filled: number[] = [];
  for (let i = 0; i < img.holes.length; i++) {
    if (img.holes[i]) holes.push(i);
    if (img.filled[i]) filled.push(i);
  }
  return { n: img.n, values: img.values, holes, filled, stats: img.stats };
}

export function toFloat(values: ArrayLike<number | null>): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = v === null || v === undefined ? NaN : v;
  }
  return out;
}

/** Pearson r between our image and the reference PNG resampled to the same grid. */
export function useReferenceCorrelation(url: string | null, image: GridImage | null): number | null {
  const [ref, setRef] = useState<{ url: string; n: number; px: Float32Array } | null>(null);
  const n = image?.n ?? 0;
  useEffect(() => {
    if (!url || !n) return;
    let alive = true;
    void loadReference(url, n).then((px) => alive && px && setRef({ url, n, px }));
    return () => {
      alive = false;
    };
  }, [url, n]);
  return useMemo(() => {
    if (!image || !ref || ref.url !== url || ref.n !== image.n) return null;
    const r = correlation(toFloat(image.values), ref.px);
    return Number.isFinite(r) ? r : null;
  }, [image, ref, url]);
}
