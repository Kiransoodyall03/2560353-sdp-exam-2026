// 10×10 dish grid: status colour + icon, sub-array outlines, wind-stow overlay. Click → drill-down,
// shift-click → multi-select.
import type { DishDTO } from '../../../shared/types';
import { DISH_ICON } from '../lib/rta';

export function DishGrid({
  dishes,
  colours,
  selected,
  highlight,
  windStow,
  onOpen,
  onToggle,
}: {
  dishes: DishDTO[];
  colours: Map<string, string>;
  selected: Set<string>;
  highlight: string | null;
  windStow: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const rows = Math.max(10, ...dishes.map((d) => d.row + 1));
  const cols = Math.max(10, ...dishes.map((d) => d.col + 1));
  const at = new Map(dishes.map((d) => [`${d.row},${d.col}`, d]));
  const sub = (r: number, c: number) => at.get(`${r},${c}`)?.subarray ?? null;

  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = at.get(`${r},${c}`);
      if (!d) {
        cells.push(<div key={`${r},${c}`} className="dish dish-empty" />);
        continue;
      }
      const s = d.subarray;
      const colour = s ? (colours.get(s) ?? '#888') : 'transparent';
      const edge = (other: string | null) => (s && other !== s ? colour : 'transparent');
      const style = {
        borderTopColor: edge(sub(r - 1, c)),
        borderBottomColor: edge(sub(r + 1, c)),
        borderLeftColor: edge(sub(r, c - 1)),
        borderRightColor: edge(sub(r, c + 1)),
      };
      const dim = highlight && s !== highlight;
      cells.push(
        <button
          key={d.id}
          className={`dish st-${d.status} ${selected.has(d.id) ? 'selected' : ''} ${dim ? 'dim' : ''}`}
          style={style}
          title={`${d.id} · ${d.status} · ${d.statusReason}${s ? ` · sub-array ${s}` : ''}`}
          aria-label={`${d.id}, ${d.status}, ${d.statusReason}${s ? `, sub-array ${s}` : ''}${selected.has(d.id) ? ', selected' : ''}`}
          aria-pressed={selected.has(d.id)}
          onClick={(e) => (e.shiftKey ? onToggle(d.id) : onOpen(d.id))}
        >
          <span className="dish-icon" aria-hidden="true">
            {DISH_ICON[d.status]}
          </span>
          <span className="dish-num">{d.id.slice(-3)}</span>
          {d.alertCount > 0 && <span className="dish-alerts">{d.alertCount}</span>}
          {d.scanProgress != null && d.status === 'scanning' && (
            <span className="dish-progress" style={{ width: `${Math.round(d.scanProgress * 100)}%` }} />
          )}
        </button>,
      );
    }
  }

  return (
    <div className="dish-grid-wrap">
      <div className="dish-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {cells}
      </div>
      {windStow && (
        <div className="wind-overlay" aria-hidden="true">
          <span>WIND STOW ENGAGED</span>
        </div>
      )}
    </div>
  );
}

export function DishLegend() {
  const items: DishDTO['status'][] = ['ok', 'scanning', 'warning', 'fault', 'stowed', 'disabled', 'offline', 'unknown'];
  return (
    <ul className="legend">
      {items.map((s) => (
        <li key={s}>
          <span className={`legend-swatch st-${s}`} aria-hidden="true">
            {DISH_ICON[s]}
          </span>
          {s}
        </li>
      ))}
    </ul>
  );
}
