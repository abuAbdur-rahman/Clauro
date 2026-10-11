/**
 * Minimal per-thread state (Task 003). In-memory Zustand; SQLite persistence
 * lands with 004. Selecting a model writes thread-level state only — the
 * thread stays open, `tools_frozen` untouched (D19).
 */
import { create } from "zustand";
import { hashSystemPrompt, type ModelWithLimits } from "./models";

export type Effort = "low" | "medium" | "high";

/**
 * Thread read-state indicator (Task 029 slice 3, B11 follow-up). Local copy —
 * the real store must never import `@/mock/seed` (shell.mockmode.test.ts);
 * the mock seed keeps its own copy for mock-only use. Truth table parity:
 * running → working; updated after read → done; updated but never read
 * (lastReadAt 0) → not-viewed; otherwise idle.
 */
export type ThreadStatus = "working" | "done" | "not-viewed" | "idle";

export interface ThreadStatusInfo {
  running: boolean;
  updatedAt: number;
  lastReadAt: number;
}

export function threadStatus(info: ThreadStatusInfo): ThreadStatus {
  if (info.running) return "working";
  if (info.updatedAt > info.lastReadAt) return info.lastReadAt === 0 ? "not-viewed" : "done";
  return "idle";
}

export interface ThreadState {
  id: string;
  open: boolean;
  model: ModelWithLimits | null;
  effort: Effort;
  /** Hash of the system prompt text. Effort must never enter it (D76). */
  promptHash: string;
  /** Unix ms of the last viewed-on-open mark. 0 = never viewed. */
  lastReadAt: number;
  /** Unix ms of the last turn-done update. 0 = no update yet. */
  updatedAt: number;
}

interface ThreadStore {
  threads: Record<string, ThreadState | undefined>;
  /** Ids of threads currently streaming/compacting. */
  running: string[];
  /** Unsent home-composer text per thread (Task 031 T8): home send navigates
      away, unmounting the composer — the text rides here, and the chat view
      sends it once on mount, then forgets it. */
  drafts: Record<string, string | undefined>;
  openThread: (id: string) => void;
  selectModel: (id: string, model: ModelWithLimits) => void;
  setEffort: (id: string, effort: Effort) => void;
  /** Stage home-composer text for pickup by the chat view. Blank is refused. */
  setDraft: (id: string, text: string) => void;
  /** Take + clear a staged draft. Null when none was staged. */
  consumeDraft: (id: string) => string | null;
  /** Viewed-on-open mark; defaults to now so callers can pass explicit time. */
  markRead: (id: string, now?: number) => void;
  /** Turn-done update stamp; defaults to now so callers can pass explicit time. */
  markUpdated: (id: string, now?: number) => void;
  setRunning: (id: string, on: boolean) => void;
  /** Indicator state for one thread. Unknown ids read as idle, never throw. */
  statusOf: (id: string) => ThreadStatus;
  reset: () => void;
}

const SYSTEM_PROMPT = "You are Clauro. Context may be lost, so record progress as it happens.";

export const useThreadStore = create<ThreadStore>()((set, get) => ({
  threads: {},
  running: [],
  drafts: {},

  openThread: (id) => {
    set((s) => ({
      threads: {
        ...s.threads,
        [id]: {
          id,
          open: true,
          model: s.threads[id]?.model ?? null,
          effort: s.threads[id]?.effort ?? "medium",
          promptHash: hashSystemPrompt(SYSTEM_PROMPT),
          // Re-opening must never clear read-state (Task 029 slice 3).
          lastReadAt: s.threads[id]?.lastReadAt ?? 0,
          updatedAt: s.threads[id]?.updatedAt ?? 0,
        },
      },
    }));
  },

  selectModel: (id, model) => {
    set((s) => {
      const t = s.threads[id];
      if (!t) throw new Error(`no such thread: ${id}`);
      return { threads: { ...s.threads, [id]: { ...t, model } } };
    });
  },

  setEffort: (id, effort) => {
    set((s) => {
      const t = s.threads[id];
      if (!t) throw new Error(`no such thread: ${id}`);
      // Effort is request-parameter state. promptHash is recomputed from the
      // same prompt text — unchanged by construction, asserted by test.
      return {
        threads: { ...s.threads, [id]: { ...t, effort, promptHash: hashSystemPrompt(SYSTEM_PROMPT) } },
      };
    });
  },

  reset: () => {
    set({ threads: {}, running: [], drafts: {} });
  },

  setDraft: (id, text) => {
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("refusing blank draft: nothing to pick up");
    set((s) => ({ drafts: { ...s.drafts, [id]: trimmed } }));
  },

  consumeDraft: (id) => {
    const text = get().drafts[id] ?? null;
    if (text !== null) {
      set((s) => ({
        drafts: Object.fromEntries(Object.entries(s.drafts).filter(([key]) => key !== id)),
      }));
    }
    return text;
  },

  markRead: (id, now = Date.now()) => {
    set((s) => {
      const t = s.threads[id];
      if (!t) throw new Error(`no such thread: ${id}`);
      return { threads: { ...s.threads, [id]: { ...t, lastReadAt: now } } };
    });
  },

  markUpdated: (id, now = Date.now()) => {
    set((s) => {
      const t = s.threads[id];
      if (!t) throw new Error(`no such thread: ${id}`);
      return { threads: { ...s.threads, [id]: { ...t, updatedAt: now } } };
    });
  },

  setRunning: (id, on) => {
    set((s) => ({
      running: on
        ? s.running.includes(id)
          ? s.running
          : [...s.running, id]
        : s.running.filter((r) => r !== id),
    }));
  },

  statusOf: (id) => {
    const s = get();
    const t = s.threads[id];
    return threadStatus({
      running: s.running.includes(id),
      updatedAt: t?.updatedAt ?? 0,
      lastReadAt: t?.lastReadAt ?? 0,
    });
  },
}));
