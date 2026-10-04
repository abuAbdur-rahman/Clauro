import { beforeEach, describe, expect, it } from "vitest";
import { useThreadStore, type ThreadState } from "./thread";
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
