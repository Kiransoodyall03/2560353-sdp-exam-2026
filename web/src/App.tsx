import { Route, Routes } from 'react-router-dom';
import { AlertBanner } from './components/AlertBanner';
import { Nav } from './components/Nav';
import { Empty } from './components/ui';
import { AlertDetailPage } from './pages/AlertDetail';
import { AnnunciatorPage } from './pages/Annunciator';
import { DishDetailPage } from './pages/DishDetail';
import { OverviewPage } from './pages/Overview';
import { ReplayPage } from './pages/Replay';
import { RtaPage } from './pages/Rta';
import { ComparePage, ScansPage } from './pages/Scans';
import { ScanViewPage } from './pages/ScanView';
import { ServicePage } from './pages/ServicePage';

export function App() {
  return (
    <div className="app">
      <Nav />
      <main className="main">
        <AlertBanner />
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/alerts" element={<AnnunciatorPage />} />
          <Route path="/alerts/:service/:alertId" element={<AlertDetailPage />} />
          <Route path="/rta" element={<RtaPage />} />
          <Route path="/rta/dish/:id" element={<DishDetailPage />} />
          <Route path="/rta/scans" element={<ScansPage />} />
          <Route path="/rta/scans/:id" element={<ScanViewPage />} />
          <Route path="/rta/compare" element={<ComparePage />} />
          <Route path="/replay" element={<ReplayPage />} />
          <Route path="/:svc" element={<ServicePage />} />
          <Route path="*" element={<Empty>Page not found.</Empty>} />
        </Routes>
      </main>
    </div>
  );
}
