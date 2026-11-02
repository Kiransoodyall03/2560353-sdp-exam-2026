import { Route, Routes } from 'react-router-dom';
import { AlertBanner } from './components/AlertBanner';
import { Nav } from './components/Nav';
import { ReplayTimeline } from './components/ReplayTimeline';
import { Empty } from './components/ui';
import { fmtTs } from './lib/format';
import { useLive } from './lib/live';
import { useReplay } from './lib/replay';
import { speedLabel } from './lib/replay-utils';
import { AlertDetailPage } from './pages/AlertDetail';
import { AnnunciatorPage } from './pages/Annunciator';
import { DishDetailPage } from './pages/DishDetail';
import { LwmPage } from './pages/Lwm';
import { OpgPage } from './pages/Opg';
import { OverviewPage } from './pages/Overview';
import { ReplayPage } from './pages/Replay';
import { RtaPage } from './pages/Rta';
import { ComparePage, ScansPage } from './pages/Scans';
import { ScanViewPage } from './pages/ScanView';
import { ServicePage } from './pages/ServicePage';

/** Instrument frame: rail, pinned annunciator strip, scrolling page, pinned replay bar. */
export function App() {
  const { simNow } = useLive();
  const { isReplaying, mode, t, speed, busy, error, toggle } = useReplay();
  // The mission clock follows the replay cursor while replaying and the live sim stream otherwise.
  const clockTs = isReplaying ? t : simNow;
  return (
    <div className={`app${isReplaying ? ' arl-replaying' : ''}`}>
      <Nav />
      <main className="main">
        <AlertBanner />
        <div className="main-scroll">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/alerts" element={<AnnunciatorPage />} />
            <Route path="/alerts/:service/:alertId" element={<AlertDetailPage />} />
            <Route path="/rta" element={<RtaPage />} />
            <Route path="/rta/dish/:id" element={<DishDetailPage />} />
            <Route path="/rta/scans" element={<ScansPage />} />
            <Route path="/rta/scans/:id" element={<ScanViewPage />} />
            <Route path="/rta/compare" element={<ComparePage />} />
            <Route path="/opg" element={<OpgPage />} />
            <Route path="/lwm" element={<LwmPage />} />
            <Route path="/replay" element={<ReplayPage />} />
            <Route path="/:svc" element={<ServicePage />} />
            <Route path="*" element={<Empty>Page not found.</Empty>} />
          </Routes>
        </div>
        <footer className="arl-replay" aria-label="Replay and live controls">
          <div className="arl-replay__clock">
            {isReplaying && <span className="arl-replay-banner">Replay {speedLabel(speed)}</span>}
            <span>
              Mission time <strong>{fmtTs(clockTs)}</strong>
            </span>
          </div>
          <div className="arl-replay__slot" data-replay-slot="timeline">
            <ReplayTimeline />
            {error && (
              <div className="arl-replay__error" role="alert">
                {error}
              </div>
            )}
          </div>
          <div className="arl-replay__mode" role="group" aria-label="Live or replay">
            <button
              type="button"
              className={`arl-replay__btn${mode === 'live' ? ' arl-replay__btn--on' : ''}`}
              aria-pressed={mode === 'live'}
              disabled={busy}
              title="Follow the live stream"
              onClick={() => {
                if (mode !== 'live') void toggle();
              }}
            >
              Live
            </button>
            <button
              type="button"
              className={`arl-replay__btn${mode === 'replay' ? ' arl-replay__btn--on' : ''}`}
              aria-pressed={mode === 'replay'}
              disabled={busy}
              title="Replay history from the playhead"
              onClick={() => {
                if (mode !== 'replay') void toggle();
              }}
            >
              Replay
            </button>
          </div>
        </footer>
      </main>
    </div>
  );
}
