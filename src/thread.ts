/**
 * Minimal per-thread state (Task 003). In-memory Zustand; SQLite persistence
 * lands with 004. Selecting a model writes thread-level state only — the
 * thread stays open, `tools_frozen` untouched (D19).
 */
import { create } from "zustand";
import { hashSystemPrompt, type ModelWithLimits } from "./models";

export type Effort = "low" | "medium" | "high";

export interface ThreadState {
  id: string;
  open: boolean;
  model: ModelWithLimits | null;
  effort: Effort;
  /** Hash of the system prompt text. Effort must never enter it (D76). */
  promptHash: string;
}

interface ThreadStore {
  threads: Record<string, ThreadState | undefined>;
  openThread: (id: string) => void;
  selectModel: (id: string, model: ModelWithLimits) => void;
  setEffort: (id: string, effort: Effort) => void;
  reset: () => void;
}

const SYSTEM_PROMPT = "You are Clauro. Context may be lost, so record progress as it happens.";

export const useThreadStore = create<ThreadStore>()((set) => ({
  threads: {},

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
    set({ threads: {} });
  },
}));
