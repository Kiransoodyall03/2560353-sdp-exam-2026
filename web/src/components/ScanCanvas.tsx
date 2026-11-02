// Draws a ScanImage-like grid onto a canvas (north up), with an optional holes overlay. The ramp comes
// from the design tokens, so the image is redrawn when the theme changes.
import { useEffect, useRef, useState } from 'react';
import { rampAt, sequentialStops, toRgb, useThemeColors, type RGB, type ThemeColors } from '../lib/colors';

export type Palette = 'gray' | 'inferno';

function colour(v: number, palette: Palette, c: ThemeColors): RGB {
  const x = Math.min(1, Math.max(0, v));
  const stops = palette === 'gray' ? [toRgb(c.surfaceSunken), toRgb(c.ink)] : sequentialStops(c);
  return rampAt(stops, x);
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
  const c = useThemeColors();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!image) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const n = image.n;
    canvas.width = n;
    canvas.height = n;
    const noData = toRgb(c.surfaceSunken);
    const unfilled = toRgb(c.alarmWarning);
    const filledIn = toRgb(c.sunset);
    const data = ctx.createImageData(n, n);
    const holes = showHoles ? new Set(image.holes ?? []) : null;
    const filled = showHoles ? new Set(image.filled ?? []) : null;
    for (let i = 0; i < n * n; i++) {
      const v = image.values[i];
      const o = i * 4;
      if (holes?.has(i) && !filled?.has(i)) {
        data.data.set([unfilled[0], unfilled[1], unfilled[2], 255], o); // hole with no sample
      } else if (filled?.has(i)) {
        data.data.set([filledIn[0], filledIn[1], filledIn[2], 255], o); // hole filled from neighbours
      } else if (v === null || v === undefined || Number.isNaN(v)) {
        data.data.set([noData[0], noData[1], noData[2], 255], o); // no data yet
      } else {
        const [r, g, b] = colour(v, palette, c);
        data.data[o] = r;
        data.data[o + 1] = g;
        data.data[o + 2] = b;
        data.data[o + 3] = 255;
      }
    }
    ctx.putImageData(data, 0, 0);
  }, [image, palette, showHoles, c]);

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
