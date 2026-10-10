/**
 * Theme state: mode + density, persisted locally, resolved live against the
 * device. `applyTheme` stays pure (its unit tests inject the boolean); this
 * hook owns the matchMedia subscription and the localStorage read/write, so
 * App renders the resolved theme instead of a hardcoded guess.
 */
import { useCallback, useEffect, useState } from "react";
import { applyTheme, type Density, type ThemeMode } from "./theme";

const MODE_KEY = "clauro.theme.mode";
const DENSITY_KEY = "clauro.theme.density";

function readMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch {
    return "system";
  }
}

function readDensity(): Density {
  try {
    return window.localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function useTheme(): {
  mode: ThemeMode;
  density: Density;
  setMode: (mode: ThemeMode) => void;
  setDensity: (density: Density) => void;
} {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [density, setDensityState] = useState<Density>(readDensity);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      applyTheme({ mode, accent: "neutral", density }, query.matches);
    };
    apply();
    query.addEventListener("change", apply);
    return () => {
      query.removeEventListener("change", apply);
    };
  }, [mode, density]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Private-mode storage failure must not break theming.
    }
  }, []);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    try {
      window.localStorage.setItem(DENSITY_KEY, next);
    } catch {
      // Same as above: theming degrades to memory-only.
    }
  }, []);

  return { mode, density, setMode, setDensity };
}
