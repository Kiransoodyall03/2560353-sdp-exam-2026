import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { LiveProvider } from './lib/live';
import { ResearcherProvider } from './lib/researcher';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ResearcherProvider>
        <LiveProvider>
          <App />
        </LiveProvider>
      </ResearcherProvider>
    </BrowserRouter>
  </StrictMode>,
);
