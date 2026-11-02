// Control panel for one service + set of entities. Everything it sends goes through the server
// pipeline (verify → safeguards → publish → ack), so refusals arrive as plain-language text and a
// 428 opens the confirmation dialog with the facts the safeguard produced.
import { useEffect, useMemo, useState } from 'react';
import type { CommandConfirmDTO, CommandSpecDTO } from '../../../shared/commands';
import type { ServiceId } from '../../../shared/types';
import { api } from '../lib/api';
import { useCommands } from '../state/CommandsContext';
import { CommandProgress } from './CommandProgress';
import { ConfirmDialog } from './ConfirmDialog';
import { ControlField, defaultValueOf, isReady, wireValue } from './ControlField';
import type { MultiOption } from './MultiSelect';
import { ErrorBox, Loading } from './ui';

interface Pending {
  spec: CommandSpecDTO;
  value: unknown;
  entity: string;
  rest: string[];
  confirm: CommandConfirmDTO;
}

export function ControlPanel({
  service,
  entities,
  kinds,
  only,
  title,
  showPresets = false,
  collapsible = false,
  defaultOpen = false,
}: {
  service: ServiceId;
  entities: string[];
  /** Keep only the controls that apply to these entity kinds (dish / subarray / global). */
  kinds?: string[];
  only?: string[];
  title?: string;
  showPresets?: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const { specs, ensure, specsLoading, specError, history, send } = useCommands();
  const controls = useMemo(() => {
    return specs(service).filter((s) => {
      if (kinds && !s.entityKinds.some((k) => kinds.includes(k))) return false;
      if (only && !only.includes(s.control)) return false;
      if (s.ui.entities && !entities.some((e) => s.ui.entities!.includes(e))) return false;
      return true;
    });
  }, [specs, service, kinds, only, entities]);

  const [values, setValues] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [targets, setTargets] = useState<MultiOption[]>([]);

  const needsTargets = controls.some((c) => c.ui.kind === 'target');
  useEffect(() => {
    ensure(service);
  }, [ensure, service]);
  useEffect(() => {
    if (!needsTargets) return;
    let alive = true;
    api
      .get<{ id: string; name: string }[]>('/api/targets')
      .then((list) => alive && setTargets(list.map((t) => ({ value: t.id, label: `${t.id} · ${t.name}` }))))
      .catch(() => {
        /* the field falls back to an empty list; the server still validates the id */
      });
    return () => {
      alive = false;
    };
  }, [needsTargets]);

  const valueOf = (spec: CommandSpecDTO) => values[spec.control] ?? defaultValueOf(spec);
  const setValue = (control: string, next: string) => setValues((prev) => ({ ...prev, [control]: next }));

  async function runBatch(spec: CommandSpecDTO, value: unknown, queue: string[], confirmToken?: string) {
    const rest = [...queue];
    while (rest.length > 0) {
      const entity = rest.shift()!;
      const o = await send({ service, entity, control: spec.control, value, ...(confirmToken ? { confirmToken } : {}) });
      confirmToken = undefined; // the token is one-shot and entity-specific
      if (o.confirm) {
        setPending({ spec, value, entity, rest, confirm: o.confirm });
        return true;
      }
      if (o.commandId) setSent((prev) => ({ ...prev, [spec.control]: [o.commandId!, ...(prev[spec.control] ?? [])].slice(0, 5) }));
      if (!o.ok) {
        setErrors((prev) => ({ ...prev, [spec.control]: `${entity}: ${o.error ?? 'refused'}` }));
        return true;
      }
    }
    return true;
  }

  async function submit(spec: CommandSpecDTO) {
    setBusy(spec.control);
    setErrors((prev) => ({ ...prev, [spec.control]: null }));
    setNotes((prev) => ({ ...prev, [spec.control]: null }));
    try {
      const value = wireValue(spec, valueOf(spec));
      await runBatch(spec, value, entities);
    } finally {
      setBusy(null);
    }
  }

  async function confirmPending() {
    if (!pending) return;
    const p = pending;
    setPending(null);
    setBusy(p.spec.control);
    try {
      await runBatch(p.spec, p.value, [p.entity, ...p.rest], p.confirm.token);
    } finally {
      setBusy(null);
    }
  }

  /** A cancelled confirmation leaves the field holding a request that was never sent: say so. */
  function cancelPending() {
    if (pending) {
      const control = pending.spec.control;
      setNotes((prev) => ({ ...prev, [control]: 'Not sent: the confirmation was cancelled, so the plant was not changed.' }));
    }
    setPending(null);
  }

  if (specsLoading(service)) return <Loading what="controls" />;
  const loadError = specError(service);
  if (loadError) return <ErrorBox>{`Controls could not be loaded: ${loadError}`}</ErrorBox>;
  if (controls.length === 0 && !showPresets) {
    return <p className="muted small">No controls are available for {entities.join(', ')}.</p>;
  }

  const body = (
    <div className="controls">
      {showPresets && <Presets service={service} />}
      {controls.map((spec) => {
        const id = `ctl-${service}-${entities.join('_')}-${spec.control}`;
        const error = errors[spec.control];
        return (
          <div key={spec.control} className={`control ${spec.ui.danger ? 'danger' : ''}`}>
            <ControlField
              id={id}
              spec={spec}
              value={valueOf(spec)}
              onChange={(v) => setValue(spec.control, v)}
              targetOptions={targets}
              disabled={busy !== null}
            />
            <div className="row gap">
              <button
                type="button"
                className={spec.ui.danger ? 'danger-button' : 'primary'}
                onClick={() => void submit(spec)}
                disabled={busy !== null || !isReady(spec, valueOf(spec))}
              >
                {busy === spec.control ? 'Sending…' : spec.ui.label}
              </button>
              {spec.ui.mayConfirm && <span className="muted small">the server may ask you to confirm</span>}
            </div>
            {error && <p className="error small" role="alert">{error}</p>}
            {notes[spec.control] && <p className="muted small">{notes[spec.control]}</p>}
            {(sent[spec.control] ?? []).map((commandId) => (
              <CommandProgress key={commandId} command={history[commandId] ?? null} showTs={false} />
            ))}
          </div>
        );
      })}
      {pending && (
        <ConfirmDialog
          confirm={pending.confirm}
          busy={busy !== null}
          onConfirm={() => void confirmPending()}
          onCancel={cancelPending}
        />
      )}
    </div>
  );

  if (!collapsible) {
    return (
      <div className="control-panel">
        {title && <h3>{title}</h3>}
        {body}
      </div>
    );
  }
  return (
    <details className="control-panel" open={defaultOpen}>
      <summary>{title ?? 'Controls'}</summary>
      {body}
    </details>
  );
}

/** One-click step sequences registered by the plugin, with the reason for any step that was refused. */
export function Presets({ service }: { service: ServiceId }) {
  const { presets, runPreset } = useCommands();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ preset: string; ok: boolean; rows: { control: string; ok: boolean; detail: string | null; commandId: string | null }[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const list = presets(service);

  async function run(id: string) {
    setBusy(id);
    setError(null);
    try {
      const r = await runPreset(id, service);
      if (r.error) setError(r.error);
      setResult({ preset: id, ok: r.ok, rows: r.results });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="presets">
      <h4>Presets</h4>
      {list.length === 0 && <p className="muted small">This service has no presets.</p>}
      <div className="row gap">
        {list.map((p) => (
          <button key={p.id} type="button" onClick={() => void run(p.id)} disabled={busy !== null} title={p.description}>
            {busy === p.id ? 'Running…' : p.name}
          </button>
        ))}
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {result && (
        <ul className="preset-result small">
          {result.rows.map((r, i) => (
            <li key={`${r.control}-${i}`} className={r.ok ? 'tone-ok' : 'tone-bad'}>
              <span className="mono">{r.control}</span> {r.ok ? 'sent' : (r.detail ?? 'refused')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
