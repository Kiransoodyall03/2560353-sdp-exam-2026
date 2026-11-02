// Draws a ScanImage-like grid onto a canvas (north up), with an optional holes overlay.
import { useEffect, useRef, useState } from 'react';

export type Palette = 'gray' | 'inferno';

// inferno, 9 stops (matplotlib), linearly interpolated
const INFERNO: [number, number, number][] = [
  [0, 0, 4],
  [31, 12, 72],
  [85, 15, 109],
  [136, 34, 106],
  [186, 54, 85],
  [227, 89, 51],
  [249, 140, 10],
  [249, 201, 50],
  [252, 255, 164],
];

function colour(v: number, palette: Palette): [number, number, number] {
  const x = Math.min(1, Math.max(0, v));
  if (palette === 'gray') {
    const g = Math.round(x * 255);
    return [g, g, g];
  }
  const p = x * (INFERNO.length - 1);
  const i = Math.min(INFERNO.length - 2, Math.floor(p));
  const f = p - i;
  const a = INFERNO[i]!;
  const b = INFERNO[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export interface GridImage {
  n: number;
  /** 0..1 row-major; null/NaN = no data. */
  values: ArrayLike<number | null>;
  /** Pixel indices that had no usable sample. */
  holes?: Iterable<number>;
  /** Pixel indices filled from neighbours. */
  filled?: Iterable<number>;
}

export function ScanCanvas({
  image,
  palette = 'gray',
  showHoles = false,
  size = 384,
  label,
}: {
  image: GridImage | null;
  palette?: Palette;
  showHoles?: boolean;
  size?: number;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    if (!image) {
      ctx.clearRect(0, 0, c.width, c.height);
      return;
    }
    const n = image.n;
    c.width = n;
    c.height = n;
    const data = ctx.createImageData(n, n);
    const holes = showHoles ? new Set(image.holes ?? []) : null;
    const filled = showHoles ? new Set(image.filled ?? []) : null;
    for (let i = 0; i < n * n; i++) {
      const v = image.values[i];
      const o = i * 4;
      if (holes?.has(i) && !filled?.has(i)) {
        data.data.set([0, 140, 255, 255], o); // unfilled hole
      } else if (filled?.has(i)) {
        data.data.set([0, 200, 255, 255], o); // filled hole
      } else if (v === null || v === undefined || Number.isNaN(v)) {
        data.data.set([18, 22, 28, 255], o); // no data yet
      } else {
        const [r, g, b] = colour(v, palette);
        data.data[o] = r;
        data.data[o + 1] = g;
        data.data[o + 2] = b;
        data.data[o + 3] = 255;
      }
    }
    ctx.putImageData(data, 0, 0);
  }, [image, palette, showHoles]);

  return (
    <canvas
      ref={ref}
      className="scan-canvas"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
      width={128}
      height={128}
    />
  );
}

/** Reference PNG from docs/reference/rta, or a note when the catalogue has none for this target/band. */
export function ReferenceImage({ url, size, label }: { url: string | null; size: number; label: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) {
    return <div className="empty">No reference image for {label}.</div>;
  }
  return (
    <img className="ref-img" src={url} width={size} height={size} alt={`Reference image for ${label}`} onError={() => setFailed(url)} />
  );
}

/** Loads a reference PNG and samples it down to n×n grayscale (0..1) for correlation. */
export async function loadReference(url: string, n: number): Promise<Float32Array | null> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  const out = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) out[i] = (0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!) / 255;
  return out;
}
