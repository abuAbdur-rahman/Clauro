// @vitest-environment jsdom
/**
 * Task 029 slice 2 — mock-tauri serves @/mock/seed.ts deterministically.
 * Failing-first: provider_list 3, transcript_read c1, turn_start echo,
 * unknown rejects. Seed always on in mock mode; `?seed=0` gives bare shell.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, listen } from "./mock-tauri";
import { SEED_CHATS, SEED_NOW } from "@/mock/seed";

function setQuery(q: string): void {
  window.history.replaceState(null, "", q === "" ? "/" : `/?${q}`);
}

beforeEach(() => {
  setQuery("");
});

describe("mock-tauri seed serving (029 slice 2)", () => {
  it("provider_list returns 3 seeded providers", async () => {
    const raw = (await invoke("provider_list")) as Array<Record<string, unknown>>;
    expect(raw).toHaveLength(3);
    const ids = raw.map((p) => p["id"]).sort();
    expect(ids).toEqual(["p1", "p2", "p3"]);
    const p1 = raw.find((p) => p["id"] === "p1") as Record<string, unknown>;
    expect(p1["display_name"]).toBe("OpenAI");
    expect(p1["kind"]).toBe("openai");
    expect(p1["base_url"]).toBe("https://api.openai.com/v1");
    expect(p1["model_count"]).toBe(2);
    expect(p1["models_fetched_at"]).toBe(Math.floor(SEED_NOW / 1000));
    expect(p1["stale"]).toBe(false);
    expect(p1["has_key"]).toBe(true);
    const p3 = raw.find((p) => p["id"] === "p3") as Record<string, unknown>;
    expect(p3["has_key"]).toBe(false);
  });

  it("transcript_read {thread_id:'c1'} returns c1 messages; unknown id is honest empty", async () => {
    const c1 = SEED_CHATS.find((c) => c.id === "c1");
    if (c1 === undefined) throw new Error("seed missing c1");
    const raw = (await invoke("transcript_read", { thread_id: "c1" })) as Array<{
      block: { kind: string; text: string };
      role: string;
    }>;
    expect(raw).toHaveLength(c1.messages.length);
    expect(raw[0].role).toBe("user");
    expect(raw[0].block.kind).toBe("text");
    expect(raw[0].block.text).toContain("debounce");
    const missing = (await invoke("transcript_read", { thread_id: "nope" })) as unknown[];
    expect(missing).toEqual([]);
  });

  it("turn_start resolves {thread_id} echoing the request", async () => {
    const a = (await invoke("turn_start", {
      threadId: "c1",
      text: "hi",
      provider: "p2",
      model: "claude-sonnet",
      effort: "medium",
      maxTokens: 100,
    })) as { thread_id: string };
    expect(a.thread_id).toBe("c1");
    const b = (await invoke("turn_start", {})) as { thread_id: string };
    expect(b.thread_id).toBe("c1");
  });

  it("provider_models_enriched serves enabled-provider models with known limits", async () => {
    const raw = (await invoke("provider_models_enriched", { id: "p2" })) as Array<
      Record<string, unknown>
    >;
    const ids = raw.map((m) => m["id"]);
    expect(ids).toContain("claude-sonnet");
    const sonnet = raw.find((m) => m["id"] === "claude-sonnet") as Record<string, unknown>;
    expect(sonnet["limits_known"]).toBe(true);
    expect(sonnet["context_window"]).toBe(200000);
    expect(sonnet["reasoning"]).toBe(true);
  });

  it("?seed=0 resolves empty for seed commands (bare shell)", async () => {
    setQuery("seed=0");
    await expect(invoke("provider_list")).resolves.toEqual([]);
    await expect(invoke("provider_models_enriched", { id: "p2" })).resolves.toEqual([]);
    await expect(invoke("transcript_read", { thread_id: "c1" })).resolves.toEqual([]);
  });

  it("unknown command still rejects loudly", async () => {
    await expect(invoke("no_such_command_xyz")).rejects.toThrow(/has no mock for invoke/);
  });

  it("turn_start streams a scripted reply: thinking, word deltas, then done", async () => {
    vi.useFakeTimers();
    try {
      const threadId = "stream-t1";
      const events: Array<{ thread_id: string; event: { type: string; text?: string } }> = [];
      const dones: Array<Record<string, unknown>> = [];
      const offEvents = await listen("clauro://turn-event", (envelope) => {
        events.push(envelope.payload as { thread_id: string; event: { type: string; text?: string } });
      });
      const offDone = await listen("clauro://turn-done", (envelope) => {
        dones.push(envelope.payload as Record<string, unknown>);
      });
      try {
        const ack = (await invoke("turn_start", {
          threadId,
          text: "help with code",
          provider: "p2",
          model: "claude-sonnet",
          effort: "medium",
          maxTokens: 100,
        })) as { thread_id: string };
        expect(ack.thread_id).toBe(threadId);
        await vi.advanceTimersByTimeAsync(10_000);
        const mine = events.filter((e) => e.thread_id === threadId);
        expect(mine.length).toBeGreaterThan(1);
        expect(mine[0].event.type).toBe("thinking_delta");
        const deltas = mine.slice(1);
        expect(deltas.every((d) => d.event.type === "text_delta")).toBe(true);
        const streamed = deltas.map((d) => d.event.text ?? "").join("");
        expect(streamed).toContain("debounce");
        const myDones = dones.filter((d) => d["thread_id"] === threadId);
        expect(myDones).toHaveLength(1);
      } finally {
        offEvents();
        offDone();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("turn-done commits the scripted reply: the re-read converges on it", async () => {
    vi.useFakeTimers();
    try {
      const threadId = "stream-persist";
      const offDone = await listen("clauro://turn-done", () => {});
      try {
        await invoke("turn_start", { threadId, text: "help with code" });
        await vi.advanceTimersByTimeAsync(10_000);
        const rows = (await invoke("transcript_read", { threadId })) as Array<{
          block: { kind: string; text: string };
          role: string;
        }>;
        expect(rows).toHaveLength(2);
        expect(rows[0].role).toBe("user");
        expect(rows[0].block.text).toBe("help with code");
        expect(rows[1].role).toBe("assistant");
        expect(rows[1].block.text).toContain("debounce");
      } finally {
        offDone();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("broadcasts to every subscriber: two listeners both receive the stream", async () => {
    vi.useFakeTimers();
    try {
      const threadId = "stream-broadcast";
      const first: unknown[] = [];
      const second: unknown[] = [];
      const offFirst = await listen("clauro://turn-event", (envelope) => {
        first.push(envelope.payload);
      });
      const offSecond = await listen("clauro://turn-event", (envelope) => {
        second.push(envelope.payload);
      });
      try {
        await invoke("turn_start", { threadId, text: "help with code" });
        await vi.advanceTimersByTimeAsync(10_000);
        const mine = (arr: unknown[]): number =>
          arr.filter((e) => (e as { thread_id: string }).thread_id === threadId).length;
        expect(mine(first)).toBeGreaterThan(1);
        expect(mine(second)).toBe(mine(first));
      } finally {
        offFirst();
        offSecond();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("?seed=0 turn_start emits nothing (honest empty)", async () => {
    setQuery("seed=0");
    vi.useFakeTimers();
    try {
      const threadId = "stream-bare";
      const events: Array<{ thread_id: string }> = [];
      const dones: Array<{ thread_id: string }> = [];
      const offEvents = await listen("clauro://turn-event", (envelope) => {
        events.push(envelope.payload as { thread_id: string });
      });
      const offDone = await listen("clauro://turn-done", (envelope) => {
        dones.push(envelope.payload as { thread_id: string });
      });
      try {
        await invoke("turn_start", { threadId, text: "hello", provider: "p2", model: "x" });
        await vi.advanceTimersByTimeAsync(10_000);
        // Filter to this thread: earlier tests' real-timer leftovers may still
        // land in the shared channel for their own thread ids.
        expect(events.filter((e) => e.thread_id === threadId)).toEqual([]);
        expect(dones.filter((d) => d.thread_id === threadId)).toEqual([]);
      } finally {
        offEvents();
        offDone();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
