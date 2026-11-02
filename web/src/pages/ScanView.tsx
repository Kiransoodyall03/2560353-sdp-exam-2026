// One scan: live image build-up while running (SSE samples → shared pipeline in the browser), stored
// raw/clean images once ended, holes overlay, reference image side by side with correlation.
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { appendColumns, buildCleanImage, buildRawImage, DEFAULT_CLEAN, emptyColumns, type ImageStats } from '../../../shared/scan-image';
import type { ScanSampleColumns, ScanSummaryDTO } from '../../../shared/types';
import { ReferenceImage, ScanCanvas, type GridImage, type Palette } from '../components/ScanCanvas';
import { Empty, ErrorBox, Loading, Panel, StatusPill } from '../components/ui';
import { api, errorText } from '../lib/api';
import { fmtDuration, fmtNum, fmtTs } from '../lib/format';
import { SCAN_STATUS_TEXT } from '../lib/labels';
import { BAND_TEXT, referenceUrl } from '../lib/rta';
import { scanImageToGrid, useReferenceCorrelation, useServerImage, type ImageMode } from '../lib/scan';
import { useSse } from '../lib/sse';

type Tuple = [string, number, number, number, number, number | null, string | null];
interface ScanDetail extends ScanSummaryDTO {
  events: { ts: number; event: string; reason: string | null }[];
}
const LIVE = new Set(['running', 'paused']);
const REBUILD_MS = 1000;

export function ScanViewPage() {
  const { id = '' } = useParams();
  const [scan, setScan] = useState<ScanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ImageMode>('clean');
  const [palette, setPalette] = useState<Palette>('gray');
  const [showHoles, setShowHoles] = useState(false);
  const [fill, setFill] = useState(true);
  const [minSnr, setMinSnr] = useState<number | null>(null);
  const [showRef, setShowRef] = useState(true);

  useEffect(() => {
    api
      .get<ScanDetail>(`/api/rta/scans/${encodeURIComponent(id)}`)
      .then((s) => {
        setScan(s);
        setError(null);
      })
      .catch((err) => setError(errorText(err)));
  }, [id]);

  const live = !!scan && LIVE.has(scan.status);
  const liveImage = useLiveImage(live ? id : null, scan, mode, minSnr, fill, (s) =>
    setScan((prev) => (prev ? { ...prev, ...s } : prev)),
  );
  // ended scans: server-stored image (re-fetched when the scan record changes, e.g. image stored on completion)
  const server = useServerImage(!live && scan ? id : null, { mode, minSnr, fill }, scan?.hasImage);
  const image: (GridImage & { stats: ImageStats }) | null = live ? liveImage : server.image;
  const ref = scan ? referenceUrl(scan.targetId, scan.band) : null;
  const r = useReferenceCorrelation(ref, image);

  if (error) return <ErrorBox>Could not load scan: {error}</ErrorBox>;
  if (!scan) return <Loading what="scan" />;
  const fovDeg = (scan.fovRad * 180) / Math.PI;

  return (
    <div className="page">
      <p>
        <Link to="/rta/scans">← Scan library</Link>
      </p>
      <h1 className="row gap">
        <span className="mono">{scan.scanId}</span>
        <StatusPill tone={live ? 'ok' : scan.status === 'failed' ? 'bad' : 'info'}>
          {SCAN_STATUS_TEXT[scan.status] ?? scan.status}
        </StatusPill>
        {live && <span className="live-dot">Live</span>}
      </h1>
      <div className="filters">
        <div className="seg" role="group" aria-label="Image">
          {(['clean', 'raw'] as const).map((m) => (
            <button key={m} type="button" className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {m === 'clean' ? 'Cleaned' : 'Raw'}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Palette">
          {(['gray', 'inferno'] as const).map((p) => (
            <button key={p} type="button" className={palette === p ? 'on' : ''} onClick={() => setPalette(p)}>
              {p === 'gray' ? 'Grey' : 'Inferno'}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={showHoles} onChange={(e) => setShowHoles(e.target.checked)} /> holes overlay
        </label>
        <label className="check">
          <input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} disabled={mode === 'raw'} /> fill holes
        </label>
        <label className="check">
          min SNR (dB)
          <input
            type="number"
            step={0.5}
            min={-50}
            max={50}
            disabled={mode === 'raw'}
            placeholder="limit"
            value={minSnr ?? ''}
            onChange={(e) => setMinSnr(e.target.value === '' ? null : Number(e.target.value))}
            style={{ width: '5em' }}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} /> reference
        </label>
      </div>

      <div className="scan-layout">
        <Panel title={`${mode === 'clean' ? 'Cleaned' : 'Raw'} image · ${scan.gridSize}×${scan.gridSize}`}>
          {server.error && !live ? (
            <ErrorBox>{server.error}</ErrorBox>
          ) : image ? (
            <ScanCanvas image={image} palette={palette} showHoles={showHoles} size={420} label={`Scan ${scan.scanId} ${mode} image`} />
          ) : (
            <Empty>{live ? 'Waiting for samples…' : 'No samples were recorded for this scan.'}</Empty>
          )}
          {showHoles && (
            <p className="small muted">
              <span className="swatch" style={{ background: 'var(--alarm-warning)' }} /> no usable sample ·{' '}
              <span className="swatch" style={{ background: 'var(--sunset)' }} /> filled from neighbours
            </p>
          )}
          <p className="small muted">North up, east left of centre offset (Δα increases to the right).</p>
        </Panel>
        {showRef && (
          <Panel title="Reference">
            <ReferenceImage
              url={ref}
              size={420}
              label={scan.targetId ? `${scan.targetId} / ${scan.band ?? '?'} band` : 'a custom target'}
            />
            <p className="small">
              Correlation (Pearson r, {scan.gridSize}×{scan.gridSize}): <strong>{r == null ? '—' : r.toFixed(3)}</strong>
            </p>
          </Panel>
        )}
        <Panel title="Scan">
          <dl className="dl compact">
            <dt>Sub-array</dt>
            <dd>
              <Link to={`/rta?subarray=${encodeURIComponent(scan.subarray)}`}>{scan.subarray}</Link>
            </dd>
            <dt>Target</dt>
            <dd>
              {scan.targetName ?? scan.targetId ?? 'Custom target'}
              {scan.raRad != null && (
                <span className="muted small">
                  {' '}
                  RA {fmtNum((scan.raRad * 180) / Math.PI, 3)}° Dec {fmtNum(((scan.decRad ?? 0) * 180) / Math.PI, 3)}°
                </span>
              )}
            </dd>
            <dt>Band</dt>
            <dd>
              {scan.band ? BAND_TEXT[scan.band] : '—'}
              {scan.bandHz && <span className="muted small"> · {fmtNum(scan.bandHz / 1e9, 3)} GHz</span>}
            </dd>
            <dt>Field of view</dt>
            <dd>
              {fmtNum(fovDeg * 60, 2)} arcmin · overlap {scan.overlap}
            </dd>
            <dt>Dishes</dt>
            <dd>{scan.dishes.length}</dd>
            <dt>Started</dt>
            <dd className="mono">{fmtTs(scan.startedTs)}</dd>
            <dt>Ended</dt>
            <dd className="mono">{fmtTs(scan.endedTs)}</dd>
            <dt>Progress</dt>
            <dd>
              {scan.progress != null ? `${Math.round(scan.progress * 100)}%` : '—'}
              {scan.etaS != null && live && ` · ETA ${fmtDuration(scan.etaS * 1000)}`}
            </dd>
            <dt>Coverage</dt>
            <dd>
              {Math.round(scan.coverage * 100)}% · {scan.samples.toLocaleString()} samples
            </dd>
            {scan.reason && (
              <>
                <dt>Reason</dt>
                <dd>{scan.reason}</dd>
              </>
            )}
            {!scan.geometryFromEvent && (
              <>
                <dt>Note</dt>
                <dd className="sev-warning small">Started before capture: grid/FOV taken from defaults and the target.</dd>
              </>
            )}
          </dl>
          {image && <Stats stats={image.stats} mode={mode} />}
          {scan.events.length > 0 && (
            <>
              <h3>Lifecycle</h3>
              <ol className="timeline compact">
                {scan.events.map((e, i) => (
                  <li key={i}>
                    <span className="mono small">{fmtTs(e.ts)}</span> {e.event}
                    {e.reason && <span className="muted"> · {e.reason}</span>}
                  </li>
                ))}
              </ol>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Stats({ stats, mode }: { stats: ImageStats; mode: ImageMode }) {
  return (
    <>
      <h3>Pipeline</h3>
      <dl className="dl compact small">
        <dt>Input samples</dt>
        <dd>{stats.input.toLocaleString()}</dd>
        {mode === 'clean' && (
          <>
            <dt>Dropped (fault)</dt>
            <dd>{stats.droppedFault.toLocaleString()}</dd>
            <dt>Dropped (low SNR)</dt>
            <dd>
              {stats.droppedSnr.toLocaleString()}
              {stats.lowSnrPixels > 0 && <span className="muted"> · {stats.lowSnrPixels} px kept low-SNR only</span>}
            </dd>
            <dt>Dish gain</dt>
            <dd>
              {fmtNum(stats.gainMin, 2)} – {fmtNum(stats.gainMax, 2)} ({stats.dishes} dishes)
            </dd>
            <dt>Background (p5)</dt>
            <dd>{fmtNum(stats.background, 4)}</dd>
            <dt>Scale p1–p99</dt>
            <dd>
              {fmtNum(stats.lo, 4)} – {fmtNum(stats.hi, 4)}
            </dd>
          </>
        )}
        <dt>Used</dt>
        <dd>{stats.used.toLocaleString()}</dd>
        <dt>Holes</dt>
        <dd>
          {stats.holes.toLocaleString()}
          {stats.filled > 0 && ` (${stats.filled.toLocaleString()} filled)`}
        </dd>
      </dl>
    </>
  );
}

/** Subscribes to scan:<id> and rebuilds the image at most once per second from accumulated samples. */
function useLiveImage(
  scanId: string | null,
  scan: ScanSummaryDTO | null,
  mode: ImageMode,
  minSnr: number | null,
  fill: boolean,
  onScan: (s: ScanSummaryDTO) => void,
): (GridImage & { stats: ImageStats }) | null {
  const cols = useRef<ScanSampleColumns>(emptyColumns());
  const dishIndex = useRef(new Map<string, number>());
  const version = useRef(0);
  const built = useRef(-1);
  const [image, setImage] = useState<(GridImage & { stats: ImageStats }) | null>(null);
  const [limit, setLimit] = useState<number>(DEFAULT_CLEAN.minSnrDb);

  useSse(scanId ? `scan:${scanId}` : null, (env) => {
    if (env.type === 'snapshot') {
      const d = env.data as { scan: ScanSummaryDTO | null; samples: ScanSampleColumns | null };
      cols.current = appendColumns(emptyColumns(), d.samples ?? emptyColumns());
      dishIndex.current = new Map(cols.current.dishes.map((id, i) => [id, i]));
      if (d.scan) onScan(d.scan);
      version.current++;
    } else if (env.type === 'patch') {
      const d = env.data as { scan?: ScanSummaryDTO };
      if (d.scan) onScan(d.scan);
    } else if (env.type === 'append') {
      const c = cols.current;
      for (const [dish, ts, dra, ddec, s, snr, f] of env.data as Tuple[]) {
        let di = dishIndex.current.get(dish);
        if (di === undefined) {
          di = c.dishes.push(dish) - 1;
          dishIndex.current.set(dish, di);
        }
        c.d.push(di);
        c.t.push(ts);
        c.ra.push(dra);
        c.dec.push(ddec);
        c.s.push(s);
        c.snr.push(snr);
        c.f.push(f);
      }
      version.current++;
    }
  });

  // the clean pipeline's default SNR limit is rta scan.min_snr_db from the ARL API (served in the rta global DTO)
  useEffect(() => {
    if (!scanId) return;
    void api
      .get<{ global?: { minSnrDb?: number } }>('/api/rta')
      .then((r) => typeof r.global?.minSnrDb === 'number' && setLimit(r.global.minSnrDb))
      .catch(() => undefined);
  }, [scanId]);

  const gridSize = scan?.gridSize;
  const fovRad = scan?.fovRad;
  const rebuild = useRef<() => void>(() => undefined);
  rebuild.current = () => {
    if (!gridSize || !fovRad || cols.current.s.length === 0) return;
    const geom = { gridSize, fovRad };
    const img =
      mode === 'raw'
        ? buildRawImage(cols.current, geom)
        : buildCleanImage(cols.current, geom, { ...DEFAULT_CLEAN, minSnrDb: minSnr ?? limit, fillHoles: fill });
    setImage(scanImageToGrid(img));
  };
  // immediate rebuild on parameter changes; new samples are picked up by a steady 1 s tick
  useEffect(() => {
    built.current = version.current;
    rebuild.current();
  }, [gridSize, fovRad, mode, minSnr, fill, limit]);
  useEffect(() => {
    if (!scanId) return;
    const t = setInterval(() => {
      if (built.current === version.current) return;
      built.current = version.current;
      rebuild.current();
    }, REBUILD_MS);
    return () => clearInterval(t);
  }, [scanId]);

  return scanId ? image : null;
}
