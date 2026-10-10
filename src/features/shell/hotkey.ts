import { useEffect } from "react";

/** In-app summon shortcut (Ctrl+K, Windows Ctrl-only per B05). Global registration
 *  needs the Tauri global-shortcut plugin — recorded follow-up; fallback says so. */
export function useSummonHotkey(onSummon: () => void): { global: boolean } {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
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

/** Settings shortcut (Ctrl+,). Same in-app scope as the summon hotkey —
 *  global registration waits on the Tauri plugin with it. */
export function useSettingsHotkey(onOpen: () => void): void {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === ",") {
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

/** Ctrl+B stays in the vendored sidebar (`sidebar.tsx:110-123`) — a second
 *  listener here would double-toggle, so it is deliberately not repeated. */

function useCtrlKey(key: string, shift: boolean, onFire: () => void): void {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && e.shiftKey === shift && e.key.toLowerCase() === key) {
        e.preventDefault();
        onFire();
      }
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, [onFire, key, shift]);
}

/** New-chat shortcut (Ctrl+N). Wiring into App view belongs to the shell
 *  owner — this hook only owns the keybinding. */
export function useNewChatHotkey(onNew: () => void): void {
  useCtrlKey("n", false, onNew);
}

/** Artifact-panel toggle (Ctrl+Shift+A). Same in-app scope as above. */
export function usePanelHotkey(onToggle: () => void): void {
  useCtrlKey("a", true, onToggle);
}

/** Compact-conversation shortcut (Ctrl+Shift+C). Dispatch belongs to 023. */
export function useCompactHotkey(onCompact: () => void): void {
  useCtrlKey("c", true, onCompact);
}

/** Maximize-icon toggle (F11). preventDefault is best-effort: browsers may
 *  reserve F11 for fullscreen; the app toggles its own icon regardless. */
export function useMaximizeHotkey(onToggle: () => void): void {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, [onToggle]);
}
