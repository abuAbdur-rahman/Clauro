/** Task 029 — SEED port fidelity. Fails until `@/mock/seed` exists. */
import { describe, expect, it } from "vitest";
import {
  SEED_CHATS,
  SEED_DEFAULT_MODEL,
  SEED_MEMORIES,
  SEED_PROJECTS,
  SEED_PROVIDERS,
  defaultMockModel,
  groupChats,
  mockTranscript,
  pickMockReply,
  threadStatus,
} from "./seed";

describe("mock seed", () => {
  it("ports providers/chats/memories/projects counts verbatim", () => {
    expect(SEED_PROVIDERS).toHaveLength(3);
    expect(SEED_CHATS).toHaveLength(11);
    expect(SEED_MEMORIES).toHaveLength(5);
    expect(SEED_PROJECTS).toHaveLength(3);
    expect(SEED_DEFAULT_MODEL).toBe("p2:claude-sonnet");
  });

  it("groups into date buckets with pinned first", () => {
    const groups = groupChats(SEED_CHATS);
    const names = groups.map(([n]) => n);
    expect(names[0]).toBe("Pinned");
    expect(names).toContain("Today");
    expect(groups.flatMap(([, v]) => v)).toHaveLength(11);
  });

  it("picks code reply on code mention, artifact otherwise round-robin", () => {
    expect(pickMockReply("help with code", 0).text).toContain("debounce");
    expect(pickMockReply("build me artifact", 0).artifact?.type).toBe("html");
    expect(pickMockReply("build doc plan", 0).artifact?.type).toBe("doc");
    expect(pickMockReply("hello", 1).text).toContain("trade-offs");
  });

  it("computes working > done > not-viewed > idle", () => {
    expect(threadStatus({ status: "idle", updatedAt: 2, lastReadAt: 1, running: true })).toBe("working");
    expect(threadStatus({ status: "idle", updatedAt: 2, lastReadAt: 1, running: false })).toBe("done");
    expect(threadStatus({ status: "idle", updatedAt: 2, lastReadAt: 0, running: false })).toBe("not-viewed");
    expect(threadStatus({ status: "idle", updatedAt: 1, lastReadAt: 1, running: false })).toBe("idle");
  });

  it("mockTranscript serves one chat's seed messages, honest empty for unknown", () => {
    const rows = mockTranscript("c1");
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe("user");
    expect(rows[0].text).toContain("debounce");
    expect(rows[1].role).toBe("assistant");
    expect(mockTranscript("no-such-chat")).toEqual([]);
  });

  it("defaultMockModel parses SEED_DEFAULT_MODEL into the thread-store shape", () => {
    const [provider, id] = SEED_DEFAULT_MODEL.split(":");
    const model = defaultMockModel();
    expect(model.provider).toBe(provider);
    expect(model.id).toBe(id);
    expect(model.name).toBe(id);
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(model.maxOutput).toBeGreaterThan(0);
    expect(typeof model.reasoning).toBe("boolean");
    expect(typeof model.toolCall).toBe("boolean");
  });
});
