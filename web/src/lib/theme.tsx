// Light/dark theme for the control room. The choice is per browser; without one the OS decides.
// The data-theme attribute is applied synchronously with the state change, so a component that reads
// CSS variables during the same render already sees the new palette.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'arl.theme';

function systemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The saved choice, or null when there is none (or storage is blocked). */
export function savedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

interface ThemeCtx {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTheme outside ThemeProvider');
  return c;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => savedTheme() ?? systemTheme());

  useEffect(() => applyTheme(theme), [theme]);

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage blocked: the choice simply does not survive a reload */
    }
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [setTheme, theme]);

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
