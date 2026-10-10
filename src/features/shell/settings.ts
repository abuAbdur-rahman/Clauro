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
}

export const useSettingsStore = create<SettingsStore>()((set) => ({
  open: false,
  section: "providers",
  displayName: "Abu",
  setDisplayName: (displayName) => {
    set({ displayName });
  },
  openSettings: (section = "providers") => {
    set({ open: true, section });
  },
  closeSettings: () => {
    set({ open: false });
  },
}));
