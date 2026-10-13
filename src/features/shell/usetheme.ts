/**
 * Theme state: mode + density + accent passthrough, persisted locally,
 * resolved live against the device. `applyTheme` stays pure (its unit tests
 * inject the boolean); this hook owns the matchMedia subscription and the
 * localStorage read/write, so App renders the resolved theme instead of a
 * hardcoded guess. A module-scope call applies the stored theme pre-paint
 * (review 31 #6) so the first frame is already correct.
 */
import { useCallback, useEffect, useState } from "react";
import { applyTheme, type Density, type ThemeMode } from "./theme";

const MODE_KEY = "clauro.theme.mode";
const DENSITY_KEY = "clauro.theme.density";
const ACCENT_KEY = "clauro.theme.accent";

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

/** The picker's persisted value (review 31 #5). `neutral` is the inert
 *  default: nothing in styles.css keys off `data-accent` yet, but the hook
 *  must never stomp a value the user picked. */
function readAccent(): string {
  try {
    return window.localStorage.getItem(ACCENT_KEY) ?? "neutral";
  } catch {
    return "neutral";
  }
}

// Pre-paint apply (review 31 #6): the hook's own effect lands after the first
// frame, so dark users flashed a light shell. This module-scope call runs at
// import time — before React renders — and is idempotent with the hook's apply
// below. Hosts without a DOM or without matchMedia (jsdom, node-ish test
// envs) skip the subscription and resolve to "not dark"; the hook re-applies
// once mounted.
if (typeof document !== "undefined") {
  const query =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : undefined;
  applyTheme(
    { mode: readMode(), accent: readAccent(), density: readDensity() },
    query?.matches ?? false,
  );
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
      // Accent rides through from the picker's persisted value — the old
      // hardcoded "neutral" undid `dataset.accent` on every mode change.
      applyTheme({ mode, accent: readAccent(), density }, query.matches);
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
