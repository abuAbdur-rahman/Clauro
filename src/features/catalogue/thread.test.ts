import { beforeEach, describe, expect, it } from "vitest";
import {
  useThreadStore,
  threadStatus,
  type ThreadState,
  type ThreadStatus,
} from "./thread";
import type { ModelWithLimits } from "./models";

const HAIKU: ModelWithLimits = {
  provider: "anthropic",
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  contextWindow: 200_000,
  maxOutput: 64_000,
  reasoning: true,
  toolCall: true,
};

function thread(id: string): ThreadState {
  const t = useThreadStore.getState().threads[id];
  if (!t) throw new Error(`test setup: no such thread ${id}`);
  return t;
}

beforeEach(() => {
  useThreadStore.getState().reset();
});

describe("thread store", () => {
  it("selecting a model writes thread-level state; the thread stays open", () => {
    const { openThread, selectModel } = useThreadStore.getState();
    openThread("t1");
    selectModel("t1", HAIKU);
    const t = thread("t1");
    expect(t.model).toMatchObject({ id: "claude-haiku-4-5" });
    expect(t.open).toBe(true);
  });

  it("effort change takes effect on next-turn state without retro-editing", () => {
    const { openThread, setEffort } = useThreadStore.getState();
    openThread("t1");
    const hashBefore = thread("t1").promptHash;
    setEffort("t1", "high");
    const t = thread("t1");
    expect(t.effort).toBe("high");
    // Stored blocks untouched; prompt hash unchanged.
    expect(t.promptHash).toBe(hashBefore);
  });

  it("selecting a model on a missing thread is a typed error, not a crash", () => {
    const { selectModel } = useThreadStore.getState();
    expect(() => {
      selectModel("nope", HAIKU);
    }).toThrow(/no such thread/);
  });
});

describe("thread read-state (Task 029 slice 3)", () => {
  it("new threads start unread with zero timestamps", () => {
    useThreadStore.getState().openThread("t1");
    const t = thread("t1");
    expect(t.lastReadAt).toBe(0);
    expect(t.updatedAt).toBe(0);
  });

  it("markRead sets lastReadAt", () => {
    const { openThread, markRead } = useThreadStore.getState();
    openThread("t1");
    markRead("t1", 1000);
    expect(thread("t1").lastReadAt).toBe(1000);
  });

  it("markUpdated sets updatedAt", () => {
    const { openThread, markUpdated } = useThreadStore.getState();
    openThread("t1");
    markUpdated("t1", 2000);
    expect(thread("t1").updatedAt).toBe(2000);
  });

  it("openThread preserves existing read-state", () => {
    const { openThread, markRead, markUpdated } = useThreadStore.getState();
    openThread("t1");
    markRead("t1", 1000);
    markUpdated("t1", 2000);
    useThreadStore.getState().openThread("t1");
    const t = thread("t1");
    expect(t.lastReadAt).toBe(1000);
    expect(t.updatedAt).toBe(2000);
    expect(t.open).toBe(true);
  });

  it("statusOf reports working while running", () => {
    const { openThread, setRunning, statusOf } = useThreadStore.getState();
    openThread("t1");
    setRunning("t1", true);
    expect(statusOf("t1")).toBe("working");
  });

  it("statusOf reports done when updated after a prior read", () => {
    const { openThread, markRead, markUpdated, statusOf } = useThreadStore.getState();
    openThread("t1");
    markRead("t1", 1000);
    markUpdated("t1", 2000);
    expect(statusOf("t1")).toBe("done");
  });

  it("statusOf reports not-viewed when updated but never read", () => {
    const { openThread, markUpdated, statusOf } = useThreadStore.getState();
    openThread("t1");
    markUpdated("t1", 2000);
    expect(statusOf("t1")).toBe("not-viewed");
  });

  it("statusOf reports idle when read is current", () => {
    const { openThread, markRead, markUpdated, statusOf } = useThreadStore.getState();
    openThread("t1");
    markUpdated("t1", 2000);
    markRead("t1", 2000);
    expect(statusOf("t1")).toBe("idle");
  });

  it("setRunning off returns to the computed read-state", () => {
    const { openThread, markRead, markUpdated, setRunning, statusOf } =
      useThreadStore.getState();
    openThread("t1");
    markRead("t1", 1000);
    markUpdated("t1", 2000);
    setRunning("t1", true);
    expect(statusOf("t1")).toBe("working");
    useThreadStore.getState().setRunning("t1", false);
    expect(useThreadStore.getState().statusOf("t1")).toBe("done");
  });

  it("threadStatus pure fn matches the mock-seed truth table", () => {
    const cases: Array<{ running: boolean; updatedAt: number; lastReadAt: number; want: ThreadStatus }> = [
      { running: true, updatedAt: 0, lastReadAt: 0, want: "working" },
      { running: false, updatedAt: 2000, lastReadAt: 1000, want: "done" },
      { running: false, updatedAt: 2000, lastReadAt: 0, want: "not-viewed" },
      { running: false, updatedAt: 1000, lastReadAt: 1000, want: "idle" },
      { running: false, updatedAt: 0, lastReadAt: 0, want: "idle" },
    ];
    for (const c of cases) {
      expect(threadStatus({ running: c.running, updatedAt: c.updatedAt, lastReadAt: c.lastReadAt })).toBe(
        c.want,
      );
    }
  });
});

describe("thread staged drafts (Task 031 T8)", () => {
  it("setDraft stores trimmed text; blank is refused, never stored", () => {
    const s = useThreadStore.getState();
    s.setDraft("t1", "  hello home  ");
    expect(useThreadStore.getState().consumeDraft("t1")).toBe("hello home");
    expect(() => {
      useThreadStore.getState().setDraft("t1", "   ");
    }).toThrow(/blank draft/);
    expect(useThreadStore.getState().consumeDraft("t1")).toBeNull();
  });

  it("consumeDraft takes once: second take is null", () => {
    useThreadStore.getState().setDraft("t1", "once");
    expect(useThreadStore.getState().consumeDraft("t1")).toBe("once");
    expect(useThreadStore.getState().consumeDraft("t1")).toBeNull();
  });

  it("reset clears staged drafts with everything else", () => {
    useThreadStore.getState().setDraft("t1", "staged");
    useThreadStore.getState().reset();
    expect(useThreadStore.getState().consumeDraft("t1")).toBeNull();
  });
});

describe("thread rail-menu overrides (review 31: Delete/Pin/Rename)", () => {
  it("renameThread sets a title override; openThread preserves it", () => {
    const s = useThreadStore.getState();
    s.openThread("t1");
    s.renameThread("t1", "Study notes");
    expect(thread("t1").title).toBe("Study notes");
    // Re-opening (the rail click path) must not clobber the override.
    useThreadStore.getState().openThread("t1");
    expect(thread("t1").title).toBe("Study notes");
  });

  it("renameThread upserts on an unknown id and never throws", () => {
    expect(() => {
      useThreadStore.getState().renameThread("ghost", "Ghost title");
    }).not.toThrow();
    expect(thread("ghost").title).toBe("Ghost title");
  });

  it("setPinned flips the pin override in both directions", () => {
    const s = useThreadStore.getState();
    s.openThread("t1");
    expect(thread("t1").pinned).toBeNull();
    s.setPinned("t1", true);
    expect(thread("t1").pinned).toBe(true);
    useThreadStore.getState().setPinned("t1", false);
    expect(thread("t1").pinned).toBe(false);
  });

  it("removeThread marks removed without deleting the row (never throws)", () => {
    const s = useThreadStore.getState();
    s.openThread("t1");
    expect(() => {
      useThreadStore.getState().removeThread("ghost");
    }).not.toThrow();
    s.removeThread("t1");
    expect(thread("t1").removed).toBe(true);
    // openThread preserves removal so a stale opener cannot resurrect it.
    useThreadStore.getState().openThread("t1");
    expect(thread("t1").removed).toBe(true);
  });

  it("reset clears overrides with everything else", () => {
    const s = useThreadStore.getState();
    s.openThread("t1");
    s.renameThread("t1", "Renamed");
    s.setPinned("t1", true);
    s.removeThread("t1");
    useThreadStore.getState().reset();
    expect(useThreadStore.getState().threads["t1"]).toBeUndefined();
  });
});

describe("per-thread composer drafts (review 30: draft survives thread switch)", () => {
  it("stores one draft per thread, read back by id", () => {
    const s = useThreadStore.getState();
    s.setComposerDraft("t1", "half-typed in t1");
    s.setComposerDraft("t2", "half-typed in t2");
    expect(s.composerDraft("t1")).toBe("half-typed in t1");
    expect(s.composerDraft("t2")).toBe("half-typed in t2");
  });

  it("blank deletes the key instead of storing it; never throws", () => {
    const s = useThreadStore.getState();
    s.setComposerDraft("t1", "hello");
    expect(() => {
      useThreadStore.getState().setComposerDraft("t1", "   ");
    }).not.toThrow();
    expect(useThreadStore.getState().composerDraft("t1")).toBeNull();
  });

  it("unknown thread reads null, never throws", () => {
    expect(useThreadStore.getState().composerDraft("ghost")).toBeNull();
  });

  it("stays separate from the one-shot home staging draft", () => {
    const s = useThreadStore.getState();
    s.setDraft("t1", "staged");
    s.setComposerDraft("t1", "typed");
    expect(s.consumeDraft("t1")).toBe("staged");
    expect(s.composerDraft("t1")).toBe("typed");
  });

  it("reset clears composer drafts with everything else", () => {
    useThreadStore.getState().setComposerDraft("t1", "typed");
    useThreadStore.getState().reset();
    expect(useThreadStore.getState().composerDraft("t1")).toBeNull();
  });
});
