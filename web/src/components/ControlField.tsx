// Renders one control from its server-supplied spec: the widget follows `ui.kind`, the unit and the
// min/max come from the spec, and only the wire value is scaled (GHz → Hz, degrees → radians).
import type { CommandSpecDTO } from '../../../shared/commands';
import type { MultiOption } from './MultiSelect';

export function ControlField({
  id,
  spec,
  value,
  onChange,
  targetOptions,
  disabled,
}: {
  id: string;
  spec: CommandSpecDTO;
  value: string;
  onChange: (next: string) => void;
  targetOptions?: MultiOption[];
  disabled?: boolean;
}) {
  const ui = spec.ui;
  const describedBy = ui.help ? `${id}-help` : undefined;

  if (ui.kind === 'boolean') {
    return (
      <label className="field">
        <span>{ui.label}</span>
        <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy}>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
        {ui.help && <span id={`${id}-help`} className="muted small">{ui.help}</span>}
      </label>
    );
  }

  if (ui.kind === 'enum') {
    return (
      <label className="field">
        <span>{ui.label}</span>
        <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy}>
          <option value="">Choose…</option>
          {(ui.options ?? []).map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
        {ui.help && <span id={`${id}-help`} className="muted small">{ui.help}</span>}
      </label>
    );
  }

  if (ui.kind === 'target') {
    return (
      <label className="field">
        <span>{ui.label}</span>
        <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy}>
          <option value="">Choose a catalogue target…</option>
          {(targetOptions ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {ui.help && <span id={`${id}-help`} className="muted small">{ui.help}</span>}
      </label>
    );
  }

  if (ui.kind === 'text') {
    return (
      <label className="field">
        <span>{ui.label}</span>
        <input id={id} type="text" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy} />
        {ui.help && <span id={`${id}-help`} className="muted small">{ui.help}</span>}
      </label>
    );
  }

  // number | timestamp
  return (
    <label className="field">
      <span>
        {ui.label}
        {ui.unit && <span className="muted small"> ({ui.unit})</span>}
      </span>
      <input
        id={id}
        type="number"
        step={ui.kind === 'timestamp' ? 1000 : 'any'}
        min={ui.min}
        max={ui.max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={describedBy}
        inputMode="decimal"
      />
      {ui.help && <span id={`${id}-help`} className="muted small">{ui.help}</span>}
    </label>
  );
}

/** Display value → the value on the wire (numbers are scaled by ui.scale). */
export function wireValue(spec: CommandSpecDTO, raw: string): unknown {
  const ui = spec.ui;
  if (ui.kind === 'boolean') return raw === 'true';
  if (ui.kind === 'number' || ui.kind === 'timestamp') {
    const n = Number(raw);
    return ui.scale ? n * ui.scale : n;
  }
  return raw;
}

export function defaultValueOf(spec: CommandSpecDTO): string {
  if (spec.ui.kind === 'boolean') return 'true';
  if (spec.ui.kind === 'enum' || spec.ui.kind === 'target') return '';
  if (spec.ui.kind === 'timestamp') return '';
  return '';
}

/** True when the field has something usable in it. */
export function isReady(spec: CommandSpecDTO, raw: string): boolean {
  const ui = spec.ui;
  if (ui.kind === 'boolean') return raw === 'true' || raw === 'false';
  if (raw.trim() === '') return false;
  if (ui.kind === 'number' || ui.kind === 'timestamp') return Number.isFinite(Number(raw));
  return true;
}
