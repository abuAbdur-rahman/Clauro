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
