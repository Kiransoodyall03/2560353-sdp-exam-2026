// Searchable multi-select used for batch dish commands and for picking entities in a panel.
import { useMemo, useState } from 'react';

export interface MultiOption {
  value: string;
  label: string;
  hint?: string;
}

export function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder = 'Filter…',
  empty = 'Nothing to select.',
}: {
  label: string;
  options: MultiOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  empty?: string;
}) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));
  }, [filter, options]);
  const chosen = new Set(value);
  const toggle = (v: string) => {
    const next = new Set(chosen);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange([...next].sort());
  };

  return (
    <div className="field multiselect">
      <span>
        {label} <span className="muted small">({value.length} of {options.length})</span>
      </span>
      <input
        type="search"
        value={filter}
        placeholder={placeholder}
        onChange={(e) => setFilter(e.target.value)}
        aria-label={`Filter ${label}`}
      />
      <div className="ms-list" role="group" aria-label={label}>
        {shown.length === 0 && <p className="muted small">{empty}</p>}
        {shown.map((o) => (
          <label key={o.value} className="check">
            <input type="checkbox" checked={chosen.has(o.value)} onChange={() => toggle(o.value)} />
            <span className="mono">{o.label}</span>
            {o.hint && <span className="muted small">{o.hint}</span>}
          </label>
        ))}
      </div>
      <div className="row gap">
        <button type="button" onClick={() => onChange(shown.map((o) => o.value).sort())} disabled={shown.length === 0}>
          Select all
        </button>
        <button type="button" onClick={() => onChange([])} disabled={value.length === 0}>
          Clear
        </button>
      </div>
    </div>
  );
}
