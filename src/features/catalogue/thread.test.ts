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
