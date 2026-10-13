/**
 * Settings dialog state (UI-GUIDE §7). Open state + active section live here
 * so every opener — rail gear, Ctrl+, palette action, model-picker entry —
 * reaches the same dialog without prop-drilling through the shell.
 */
import { create } from "zustand";

export type SettingsSection =
  | "general"
  | "appearance"
  | "providers"
  | "models"
  | "memory"
  | "data"
  | "shortcuts"
  | "about";

interface SettingsStore {
  open: boolean;
  section: SettingsSection;
  /** Display name for the home greeting + profile (reference `prefs.name`, default Abu). */
  displayName: string;
  setDisplayName: (name: string) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  /** Providers surface open state (review 31): lives here because the
      settings dialog's own "Open Providers" CTA must reach the dialog the
      shell renders — a shell-local useState is unreachable from a feature
      component. */
  providersOpen: boolean;
  openProviders: () => void;
  closeProviders: () => void;
}

/** Greeting fallback; the General pane's blank name maps back to this. */
export const DEFAULT_DISPLAY_NAME = "Abu";

export const useSettingsStore = create<SettingsStore>()((set) => ({
  open: false,
  section: "providers",
  displayName: DEFAULT_DISPLAY_NAME,
  setDisplayName: (displayName) => {
    set({ displayName });
  },
  openSettings: (section = "providers") => {
    set({ open: true, section });
  },
  closeSettings: () => {
    set({ open: false });
  },
  providersOpen: false,
  openProviders: () => {
    set({ providersOpen: true });
  },
  closeProviders: () => {
    set({ providersOpen: false });
  },
}));
