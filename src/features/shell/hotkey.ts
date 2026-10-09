import { useEffect } from "react";

/** In-app summon shortcut (Ctrl/Cmd+K). Global registration needs the
 *  Tauri global-shortcut plugin — recorded follow-up; fallback says so. */
export function useSummonHotkey(onSummon: () => void): { global: boolean } {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onSummon();
      }
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, [onSummon]);
  return { global: false };
}

/** Settings shortcut (Ctrl/Cmd+,). Same in-app scope as the summon hotkey —
 *  global registration waits on the Tauri plugin with it. */
export function useSettingsHotkey(onOpen: () => void): void {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, [onOpen]);
}
