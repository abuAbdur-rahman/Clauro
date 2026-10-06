/**
 * Artifact drawer state, sandbox tokens, and the Linux gate (Task 013).
 *
 * The drawer is a layout column with three states (DESIGN.md §2.4): empty
 * (zero width), compiling (says "compiling"), live. The sandbox comes from
 * the `sandbox` attribute alone — never `allow-same-origin` (D2). On Linux
 * without a proven opaque origin the drawer disables with a notice (D45).
 */
import { create } from "zustand";

export type DrawerState = "empty" | "compiling" | "live";

export interface DrawerEntry {
  state: DrawerState;
  artifactId: string | null;
  version: number | null;
  /** D45 notice; set exactly when the drawer is disabled on Linux. */
  notice: string | null;
}

interface DrawerStore {
  drawers: Record<string, DrawerEntry | undefined>;
  setCompiling: (threadId: string, artifactId: string) => void;
  setLive: (threadId: string, artifactId: string, version: number) => void;
  setNotice: (threadId: string, notice: string) => void;
  clear: (threadId: string) => void;
  reset: () => void;
}

const EMPTY: DrawerEntry = { state: "empty", artifactId: null, version: null, notice: null };

export const useDrawerStore = create<DrawerStore>()((set) => ({
  drawers: {},

  setCompiling: (threadId, artifactId) => {
    set((s) => ({
      drawers: {
        ...s.drawers,
        [threadId]: { state: "compiling", artifactId, version: null, notice: null },
      },
    }));
  },

  setLive: (threadId, artifactId, version) => {
    set((s) => ({
      drawers: {
        ...s.drawers,
        [threadId]: { state: "live", artifactId, version, notice: null },
      },
    }));
  },

  setNotice: (threadId, notice) => {
    set((s) => ({
      drawers: {
        ...s.drawers,
        [threadId]: { state: "empty", artifactId: null, version: null, notice },
      },
    }));
  },

  clear: (threadId) => {
    set((s) => ({ drawers: { ...s.drawers, [threadId]: { ...EMPTY } } }));
  },

  reset: () => {
    set({ drawers: {} });
  },
}));

/** The only sandbox tokens the frame ever carries (D2). */
export const SANDBOX_TOKENS: readonly string[] = ["allow-scripts"] as const;

/** Serialise the sandbox attribute. `allow-same-origin` is refused: adding
 * it silently breaks the opaque origin *and* the `event.origin` check (D2). */
export function sandboxAttr(extra: readonly string[] = []): string {
  for (const token of extra) {
    if (token === "allow-same-origin") {
      throw new Error("allow-same-origin would void the opaque origin (D2)");
    }
  }
  return [...SANDBOX_TOKENS, ...extra].join(" ");
}

export interface EngineGate {
  platform: "windows" | "linux";
  /** True once a probe proved the opaque origin on this engine (001/D45). */
  opaqueProven: boolean;
}

export interface GateVerdict {
  enabled: boolean;
  notice: string | null;
}

/** D45: one package, runtime gate. Linux without proof disables with a notice
 * naming the reason; everything else renders. */
export function artifactGate(gate: EngineGate): GateVerdict {
  if (gate.platform === "linux" && !gate.opaqueProven) {
    return {
      enabled: false,
      notice:
        "Artifacts are off on Linux: this engine has not proven an opaque origin (D45). " +
        "Chat, tools, and everything else work normally.",
    };
  }
  return { enabled: true, notice: null };
}
