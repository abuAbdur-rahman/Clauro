/**
 * Settings dialog state (UI-GUIDE §7). Open state + active section live here
 * so every opener — rail gear, Ctrl+, palette action, model-picker entry —
 * reaches the same dialog without prop-drilling through the shell.
 */
import { create } from "zustand";

export type SettingsSection = "providers" | "appearance" | "data";

interface SettingsStore {
  open: boolean;
  section: SettingsSection;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
}

export const useSettingsStore = create<SettingsStore>()((set) => ({
  open: false,
  section: "providers",
  openSettings: (section = "providers") => {
    set({ open: true, section });
  },
  closeSettings: () => {
    set({ open: false });
  },
}));
