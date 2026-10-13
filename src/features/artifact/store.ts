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
  /** `artifactId` is null at block start: the model asked, the id does not
   * exist until the loop generates it (D121). */
  setCompiling: (threadId: string, artifactId: string | null) => void;
  setLive: (threadId: string, artifactId: string, version: number) => void;
  setNotice: (threadId: string, notice: string) => void;
  clear: (threadId: string) => void;
  reset: () => void;
}

const EMPTY: DrawerEntry = { state: "empty", artifactId: null, version: null, notice: null };

/** Upper bound on remembered drawers. The map is keyed by thread and nothing
 * else ever evicts it, so without a bound a long session grows it forever
 * (audit 14, D27: bounded on the way out). */
export const DRAWER_MAX_THREADS = 64;

/**
 * Insert or refresh one key (moving it to the recent end) and keep the map
 * within `limit` keys, evicting from the oldest end.
 *
 * Built by rebuilding rather than `delete`: dynamic delete is exactly what
 * `no-dynamic-delete` exists to prevent, and rebuilding an insertion-ordered
 * map is the same work with a result that cannot leave a half-deleted key
 * behind. Rebuilding is what makes the refresh work too — re-assigning an
 * existing key would keep its original position, so the thread the shell is
 * actively showing would be the first one evicted.
 */
export function withRecentEntry<T>(
  map: Record<string, T>,
  key: string,
  value: T,
  limit: number,
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const mapKey of Object.keys(map)) {
    if (mapKey !== key) merged[mapKey] = map[mapKey];
  }
  merged[key] = value;
  const keys = Object.keys(merged);
  if (keys.length <= limit) return merged;
  const kept: Record<string, T> = {};
  const start = keys.length - limit;
  for (let i = start; i < keys.length; i += 1) {
    const keptKey = keys[i];
    kept[keptKey] = merged[keptKey];
  }
  return kept;
}

/** Drawer-specific bound: see `withRecentEntry`. */
function withRecency(
  drawers: Record<string, DrawerEntry | undefined>,
  threadId: string,
  entry: DrawerEntry,
): Record<string, DrawerEntry | undefined> {
  return withRecentEntry(drawers, threadId, entry, DRAWER_MAX_THREADS);
}

export const useDrawerStore = create<DrawerStore>()((set) => ({
  drawers: {},

  setCompiling: (threadId, artifactId) => {
    set((s) => ({
      drawers: withRecency(s.drawers, threadId, {
        state: "compiling",
        artifactId,
        version: null,
        notice: null,
      }),
    }));
  },

  setLive: (threadId, artifactId, version) => {
    set((s) => ({
      drawers: withRecency(s.drawers, threadId, {
        state: "live",
        artifactId,
        version,
        notice: null,
      }),
    }));
  },

  setNotice: (threadId, notice) => {
    set((s) => ({
      drawers: withRecency(s.drawers, threadId, {
        state: "empty",
        artifactId: null,
        version: null,
        notice,
      }),
    }));
  },

  clear: (threadId) => {
    set((s) => ({ drawers: withRecency(s.drawers, threadId, { ...EMPTY }) }));
  },

  reset: () => {
    set({ drawers: {} });
  },
}));

/** The only sandbox tokens the frame ever carries (D2). */
export const SANDBOX_TOKENS: readonly string[] = ["allow-scripts"] as const;

/** Serialise the sandbox attribute.
 *
 * Nothing outside the fixed token set is ever appended: the parameter exists
 * so a would-be widening *throws* here instead of silently widening the frame
 * (D108). `allow-same-origin` keeps its own message because of what it
 * breaks — the opaque origin and the `event.origin` check alike (D2). */
export function sandboxAttr(extra: readonly string[] = []): string {
  for (const token of extra) {
    if (token === "allow-same-origin") {
      throw new Error("allow-same-origin would void the opaque origin (D2)");
    }
    throw new Error(
      `sandbox token "${token}" is not on the fixed sandbox allowlist (D108): ` +
        SANDBOX_TOKENS.join(" "),
    );
  }
  return [...SANDBOX_TOKENS, ...extra].join(" ");
}

export interface EngineGate {
  platform: "windows" | "mac" | "linux" | "other";
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

/** The 021 opaque-origin probe's verdict, once Task 021 records one. Null
 * until then — an unknown engine is an unproven engine. */
let opaqueOriginProbe: boolean | null = null;

export function recordOpaqueOriginProbe(proven: boolean): void {
  opaqueOriginProbe = proven;
}

/**
 * Derive the gate from this runtime (audit 14: the gate used to be dead
 * code — every caller hardcoded `{ platform: "windows" }`).
 *
 * The platform comes from the user agent because that is the engine actually
 * rendering the artifact; the probe slot is what Task 021 will fill once an
 * opaque origin is demonstrated. Fail-closed default: unproven.
 */
export function detectEngineGate(): EngineGate {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const platform: EngineGate["platform"] = /\blinux\b/i.test(ua)
    ? "linux"
    : /\bmac\b|macintosh/i.test(ua)
      ? "mac"
      : /\bwin/i.test(ua)
        ? "windows"
        : "other";
  return { platform, opaqueProven: opaqueOriginProbe === true };
}

/**
 * The nonce of the document last published (D6/D123), written by
 * `prepareArtifact` and read by `hostSide`: the hello must name the document
 * this host built, or a page the frame navigated to could claim the channel.
 */
let renderNonce: string | null = null;

export function setRenderNonce(nonce: string | null): void {
  renderNonce = nonce;
}

export function getRenderNonce(): string | null {
  return renderNonce;
}
