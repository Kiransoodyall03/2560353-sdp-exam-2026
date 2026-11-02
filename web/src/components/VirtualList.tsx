// Fixed-row-height virtual list: renders only the visible window (+ overscan), so thousands of rows stay cheap.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function VirtualList<T>({
  items,
  rowHeight,
  render,
  overscan = 8,
  className,
  ariaLabel,
}: {
  items: T[];
  rowHeight: number;
  render: (item: T, index: number) => ReactNode;
  overscan?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    rows.push(
      <div key={i} className="vrow" style={{ top: i * rowHeight, height: rowHeight }}>
        {render(items[i]!, i)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      className={`vlist ${className ?? ''}`}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      role="list"
      aria-label={ariaLabel}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}
