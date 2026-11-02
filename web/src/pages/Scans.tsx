// Scan library (stored scans, filter, pick two to compare) and the side-by-side compare view.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ScanSummaryDTO } from '../../../shared/types';
import { ReferenceImage, ScanCanvas, type Palette } from '../components/ScanCanvas';
import { Empty, ErrorBox, Loading, Panel, StatusPill, type Tone } from '../components/ui';
import { api, errorText } from '../lib/api';
import { fmtDuration, fmtTs } from '../lib/format';
import { referenceUrl } from '../lib/rta';
import { useReferenceCorrelation, useServerImage, type ImageMode } from '../lib/scan';

const STATUS_TONE: Record<string, Tone> = { running: 'ok', paused: 'warn', completed: 'info', cancelled: 'idle', failed: 'bad', unknown: 'idle' };

export function ScanTable({
  scans,
  selectable,
  selected,
  onToggle,
}: {
  scans: ScanSummaryDTO[];
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
}) {
  if (scans.length === 0) return <Empty>No scans recorded yet.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {selectable && <th aria-label="Compare" />}
            <th>Started (SAST)</th>
            <th>Scan</th>
            <th>Sub-array</th>
            <th>Target</th>
            <th>Band</th>
            <th>Status</th>
            <th>Samples</th>
            <th>Coverage</th>
            <th>Duration</th>
            <th>Image</th>
          </tr>
        </thead>
        <tbody>
          {scans.map((s) => (
            <tr key={s.scanId}>
              {selectable && (
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Compare ${s.scanId}`}
                    checked={selected?.has(s.scanId) ?? false}
                    onChange={() => onToggle?.(s.scanId)}
                  />
                </td>
              )}
              <td className="mono">{fmtTs(s.startedTs)}</td>
              <td>
                <Link to={`/rta/scans/${s.scanId}`} className="mono">
                  {s.scanId}
                </Link>
              </td>
              <td>{s.subarray}</td>
              <td>
                {s.targetName ?? s.targetId ?? (s.raRad != null ? 'custom' : '—')}
                {s.targetId && <span className="muted mono small"> {s.targetId}</span>}
              </td>
              <td>{s.band ?? '—'}</td>
              <td>
                <StatusPill tone={STATUS_TONE[s.status] ?? 'idle'}>{s.status}</StatusPill>
                {s.reason && <span className="muted small"> {s.reason}</span>}
              </td>
              <td className="mono">{s.samples.toLocaleString()}</td>
              <td className="mono">{Math.round(s.coverage * 100)}%</td>
              <td className="mono">
                {s.startedTs && s.endedTs
                  ? fmtDuration(s.endedTs - s.startedTs)
                  : s.etaS != null
                    ? `ETA ${fmtDuration(s.etaS * 1000)}`
                    : '—'}
              </td>
              <td>{s.hasImage ? '✓ stored' : s.status === 'running' ? 'live' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScansPage() {
  const [scans, setScans] = useState<ScanSummaryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [band, setBand] = useState('');
  const nav = useNavigate();

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<ScanSummaryDTO[]>('/api/rta/scans')
        .then((s) => alive && (setScans(s), setError(null)))
        .catch((err) => alive && setError(errorText(err)));
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const targets = useMemo(() => [...new Set((scans ?? []).map((s) => s.targetId).filter(Boolean))] as string[], [scans]);
  const shown = (scans ?? []).filter((s) => (!target || s.targetId === target) && (!band || s.band === band));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="page">
      <p>
        <Link to="/rta">← Radio Telescope Array</Link>
      </p>
      <h1>Scan library</h1>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="filters">
        <select aria-label="Target" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">All targets</option>
          {targets.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select aria-label="Band" value={band} onChange={(e) => setBand(e.target.value)}>
          <option value="">All bands</option>
          <option value="L">L</option>
          <option value="C">C</option>
          <option value="K">K</option>
        </select>
        <button
          className="primary"
          disabled={selected.size < 2}
          onClick={() => nav(`/rta/compare?ids=${[...selected].map(encodeURIComponent).join(',')}`)}
        >
          Compare {selected.size >= 2 ? selected.size : ''} selected
        </button>
        <span className="muted small">Tick two or more scans to compare them side by side.</span>
      </div>
      <Panel>{scans === null ? <Loading what="scans" /> : <ScanTable scans={shown} selectable selected={selected} onToggle={toggle} />}</Panel>
    </div>
  );
}

export function ComparePage() {
  const [params] = useSearchParams();
  const ids = (params.get('ids') ?? '').split(',').filter(Boolean).slice(0, 4);
  const [mode, setMode] = useState<ImageMode>('clean');
  const [palette, setPalette] = useState<Palette>('gray');
  const [showRef, setShowRef] = useState(true);
  return (
    <div className="page">
      <p>
        <Link to="/rta/scans">← Scan library</Link>
      </p>
      <h1>Compare scans</h1>
      <div className="filters">
        <div className="seg" role="group" aria-label="Image">
          {(['clean', 'raw'] as const).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Palette">
          {(['gray', 'inferno'] as const).map((p) => (
            <button key={p} className={palette === p ? 'on' : ''} onClick={() => setPalette(p)}>
              {p}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} /> show reference
        </label>
      </div>
      {ids.length < 2 ? (
        <Empty>Pick at least two scans in the library.</Empty>
      ) : (
        <div className="compare">
          {ids.map((id) => (
            <CompareColumn key={id} id={id} mode={mode} palette={palette} showRef={showRef} />
          ))}
        </div>
      )}
    </div>
  );
}

function CompareColumn({ id, mode, palette, showRef }: { id: string; mode: ImageMode; palette: Palette; showRef: boolean }) {
  const [scan, setScan] = useState<ScanSummaryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<ScanSummaryDTO>(`/api/rta/scans/${encodeURIComponent(id)}`)
      .then(setScan)
      .catch((err) => setError(errorText(err)));
  }, [id]);
  const { image, error: imgError } = useServerImage(scan ? id : null, { mode });
  const ref = scan ? referenceUrl(scan.targetId, scan.band) : null;
  const r = useReferenceCorrelation(ref, image);
  if (error) return <ErrorBox>{id}: {error}</ErrorBox>;
  if (!scan) return <Loading what={id} />;
  return (
    <Panel title={<Link to={`/rta/scans/${id}`}>{id}</Link>}>
      <div className="muted small">
        {scan.targetName ?? scan.targetId ?? 'custom'} · {scan.band ?? '?'} band · {fmtTs(scan.startedTs)} · {scan.status}
      </div>
      {imgError ? <ErrorBox>{imgError}</ErrorBox> : <ScanCanvas image={image} palette={palette} size={300} label={`${id} ${mode} image`} />}
      {showRef && (
        <ReferenceImage url={ref} size={300} label={scan.targetId ? `${scan.targetId} / ${scan.band ?? '?'} band` : 'a custom target'} />
      )}
      <div className="small">Correlation with reference: {r == null ? '—' : r.toFixed(3)}</div>
    </Panel>
  );
}
