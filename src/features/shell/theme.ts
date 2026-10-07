export type ThemeMode = "light" | "dark" | "system";
export type Density = "compact" | "comfortable";

export interface Theme {
  mode: ThemeMode;
  accent: string;
  density: Density;
}

/** Resolve before first paint — no flash of wrong theme (020). */
export function applyTheme(t: Theme, systemDark: boolean): "light" | "dark" {
  const resolved = t.mode === "system" ? (systemDark ? "dark" : "light") : t.mode;
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.dataset.density = t.density;
    document.documentElement.dataset.accent = t.accent;
  }
  return resolved;
}
