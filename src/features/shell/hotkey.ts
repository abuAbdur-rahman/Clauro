import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** The summon chord (Ctrl+K, Windows Ctrl-only per B05) in both its forms:
 *  the accelerator the host registers and the combo the UI displays. They
 *  are deliberately the same chord: while the shortcut is live the OS
 *  consumes Ctrl+K before the webview sees it (so the two paths cannot
 *  double-fire), and when the host could not register it — a conflict, or
 *  no host at all in a plain browser — the in-app listener below still
 *  works, unchanged. */
export const SUMMON_COMBO = "Ctrl+K";
/** The event the host fires when it consumed the press globally: the OS ate
 *  the keydown, so the press is re-delivered here instead (Task 020). */
export const SUMMON_EVENT = "clauro://summon";

/** Whether the host registered the shortcut globally, and why not if it did
 *  not. `combo` is always the chord's display form — the fallback is the
 *  same key, still handled in-app. */
export interface SummonStatus {
  global: boolean;
  combo: string;
  reason: string | null;
}

/** Ask the host whether the summon hotkey registered. Typed and total: an
 *  Ok resolves to `{global: true, …, reason: null}`; a rejection — the
 *  recorded conflict reason, a host that skipped setup, or no host at all —
 *  resolves to the fallback status. The caller (a settings line) reports
 *  what came back; this never throws. */
export async function summonHotkeyStatus(): Promise<SummonStatus> {
  try {
    const raw: unknown = await invoke("summon_hotkey_status");
    if (typeof raw !== "string") {
      return {
        global: false,
        combo: SUMMON_COMBO,
        reason: "host did not report a registered hotkey",
      };
    }
    return { global: true, combo: raw, reason: null };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
    return { global: false, combo: SUMMON_COMBO, reason };
  }
}

/** In-app summon shortcut (Ctrl+K) plus the host bridge: when the OS
 *  consumed the press globally the host re-delivers it as
 *  `clauro://summon`, and both paths funnel into the same handler. The
 *  keydown listener stays installed regardless — it IS the fallback when
 *  global registration failed (Task 020). `global` reports the host's
 *  recorded outcome. */
export function useSummonHotkey(onSummon: () => void): { global: boolean } {
  const [global, setGlobal] = useState(false);
  // The caller passes an inline arrow, so `onSummon` is a new function every
  // render. The host bridge must NOT depend on it: re-running the fetch per
  // render turns one press into an invoke storm, and a later fetch racing an
  // earlier one can flip `global` back (caught by this hook's own status
  // test). The keydown listener keeps the direct dep — its re-subscribe is
  // the cheap, always-correct path — while the bridge reads the latest
  // handler through a ref.
  const latest = useRef(onSummon);
  useEffect(() => {
    latest.current = onSummon;
  }, [onSummon]);
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
  useEffect(() => {
    let alive = true;
    void summonHotkeyStatus().then((s) => {
      if (alive) setGlobal(s.global);
    });
    // Fire-and-forget, mirroring the turn-stream listener (turn.ts): a
    // failed attach — there is no event bus outside Tauri — leaves the
    // keydown fallback above as the only path, which is always installed.
    let unlisten: (() => void) | undefined;
    void listen(SUMMON_EVENT, () => {
      latest.current();
    })
      .then((drop) => {
        if (alive) {
          unlisten = drop;
        } else {
          drop();
        }
      })
      .catch(() => {
        /* no host event bus — the in-app keydown above still fires */
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return { global };
}

/** Settings shortcut (Ctrl+,). In-app scope only — Task 020 made the
 *  *summon* chord global; settings stays deliberately local, so a second
 *  global chord never competes with the first. */
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
