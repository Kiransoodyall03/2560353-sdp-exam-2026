import { Route, Routes } from 'react-router-dom';
import { AlertBanner } from './components/AlertBanner';
import { Nav } from './components/Nav';
import { Empty } from './components/ui';
import { fmtTs } from './lib/format';
import { useLive } from './lib/live';
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
  return (
    <div className="app">
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
            Mission time <strong>{fmtTs(simNow)}</strong>
          </div>
          <div
            className="arl-replay__slot"
            data-replay-slot="timeline"
            aria-label="Replay timeline (arrives in a later phase)"
          />
          <button
            type="button"
            className="arl-replay__btn arl-replay__btn--on"
            aria-pressed="true"
            title="Following the live stream. The replay timeline arrives in a later phase."
          >
            Live
          </button>
        </footer>
      </main>
    </div>
  );
}
