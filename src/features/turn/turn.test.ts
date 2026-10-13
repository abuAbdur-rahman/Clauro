/**
 * Turn bridge tests (023 host obligation). The event channel is the only path
 * from a running turn to the view — these pin the parsing half, which is all
 * that is testable without a Tauri runtime. The invoke wrappers are thin by
 * construction, like `features/catalogue/catalogue.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  TURN_EVENT,
  TURN_DONE,
  artifactLatest,
  listenTurnEvents,
  listenTurnDone,
  parseTranscript,
  parseTurnDone,
  parseTurnEvent,
  questionAnswer,
  transcriptRead,
  turnStart,
  turnStop,
} from "./turn";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useThreadStore } from "../catalogue/thread";
import type { TurnEvent, TurnDone } from "./turn";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockedListen = vi.mocked(listen);

/** What `listen` hands its callback: an envelope carrying a `payload`. */
type EnvelopeHandler = (envelope: { payload: unknown }) => void;

beforeEach(() => {
  vi.clearAllMocks();
  useThreadStore.getState().reset();
});

/** Wire params for one turn, minimal but complete. */
function turnParams(threadId: string) {
  return {
    threadId,
    text: "hi",
    provider: "anthropic",
    model: "m",
    effort: "medium",
    maxTokens: 4096,
  };
}

describe("invoke wire keys", () => {
  // REGRESSION 2026-10-07: the running app refused every call with
  // "missing required key threadId" because the payload used snake_case.
  // Tauri exposes Rust `thread_id`/`max_tokens` as camelCase JS keys and
  // matches them exactly — there is no build-time error, only the runtime
  // refusal plus an orange error dump where the transcript should be.
  it("turnStart sends camelCase keys exactly", async () => {
    vi.mocked(invoke).mockResolvedValue({ thread_id: "t1" });
    await turnStart({
      threadId: "t1",
      text: "hi",
      provider: "anthropic",
      model: "m",
      effort: "medium",
      maxTokens: 4096,
    });
    expect(invoke).toHaveBeenCalledWith("turn_start", {
      threadId: "t1",
      text: "hi",
      provider: "anthropic",
      model: "m",
      effort: "medium",
      maxTokens: 4096,
    });
  });

  it("turnStop sends threadId", async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    await expect(turnStop("t1")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("turn_stop", { threadId: "t1" });
  });

  it("transcriptRead sends threadId", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await expect(transcriptRead("t1")).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith("transcript_read", { threadId: "t1" });
  });

  // Same Tauri rule: Rust `tool_call_id` arrives as camelCase. The resolution
  // shape is validated — a malformed resolution throws instead of rendering.
  it("questionAnswer sends camelCase keys and validates the resolution", async () => {
    vi.mocked(invoke).mockResolvedValue({ card_id: "call-q", resolved: "a" });
    const out = await questionAnswer({
      threadId: "t1",
      toolCallId: "call-q",
      answer: "a",
      provider: "anthropic",
      model: "m",
      effort: "medium",
      maxTokens: 4096,
    });
    expect(out).toEqual({ card_id: "call-q", resolved: "a" });
    expect(invoke).toHaveBeenCalledWith("question_answer", {
      threadId: "t1",
      toolCallId: "call-q",
      answer: "a",
      provider: "anthropic",
      model: "m",
      effort: "medium",
      maxTokens: 4096,
    });
  });

  it("questionAnswer rejects a malformed resolution", async () => {
    vi.mocked(invoke).mockResolvedValue({ nope: true });
    await expect(
      questionAnswer({
        threadId: "t1",
        toolCallId: "call-q",
        answer: "a",
        provider: "anthropic",
        model: "m",
        effort: "medium",
        maxTokens: 4096,
      }),
    ).rejects.toThrow();
  });

  // The drawer's production producer (D121) reads the thread's newest
  // artifact through this command; `null` is a valid answer (a thread with
  // no artifacts) and the document shape is validated, never trusted.
  it("artifactLatest sends threadId and passes null through", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await expect(artifactLatest("t1")).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith("artifact_latest", { threadId: "t1" });
  });

  it("artifactLatest validates the document shape", async () => {
    vi.mocked(invoke).mockResolvedValue({
      artifactId: "a9",
      version: 2,
      title: "Demo",
      mediaType: "text/html",
      source: "<h1>x</h1>",
    });
    await expect(artifactLatest("t1")).resolves.toEqual({
      artifactId: "a9",
      version: 2,
      title: "Demo",
      mediaType: "text/html",
      source: "<h1>x</h1>",
    });
    vi.mocked(invoke).mockResolvedValue({ artifactId: "a9" });
    await expect(artifactLatest("t1")).rejects.toThrow();
  });
});

describe("parseTurnEvent", () => {
  it("parses a text delta with its thread", () => {
    const out = parseTurnEvent({
      thread_id: "t1",
      event: { type: "text_delta", index: 0, text: "hello" },
    });
    expect(out.thread_id).toBe("t1");
    expect(out.event).toEqual({ type: "text_delta", index: 0, text: "hello" });
  });

  it("parses a thinking delta distinctly from a text delta", () => {
    const out = parseTurnEvent({
      thread_id: "t1",
      event: { type: "thinking_delta", index: 1, text: "hmm" },
    });
    expect(out.event.type).toBe("thinking_delta");
  });

  it("parses usage for the meter", () => {
    const out = parseTurnEvent({
      thread_id: "t1",
      event: { type: "usage", input_tokens: 120, output_tokens: 34 },
    });
    expect(out.event).toEqual({ type: "usage", input_tokens: 120, output_tokens: 34 });
  });

  it("rejects garbage instead of rendering it", () => {
    expect(() => parseTurnEvent({ thread_id: "t1", event: { type: "text_delta" } })).toThrow();
    expect(() => parseTurnEvent({ nope: true })).toThrow();
  });
});

describe("parseTurnDone", () => {
  it("parses a completed turn", () => {
    const out = parseTurnDone({
      thread_id: "t1",
      end: "EndTurn",
      dispatched: ["call-1"],
      assistant_messages: 2,
      pending_approvals: [],
    });
    expect(out.thread_id).toBe("t1");
    if ("end" in out) {
      expect(out.end).toBe("EndTurn");
      expect(out.dispatched).toEqual(["call-1"]);
    } else {
      throw new Error("expected a completed turn");
    }
  });

  it("parses a failed turn with its message", () => {
    const out = parseTurnDone({ thread_id: "t1", error: "provider returned HTTP 429" });
    if ("error" in out) {
      expect(out.error).toMatch(/429/);
    } else {
      throw new Error("expected a failed turn");
    }
  });

  it("rejects garbage instead of rendering it", () => {
    expect(() => parseTurnDone({ thread_id: "t1" })).toThrow();
  });
});

describe("parseTranscript", () => {
  it("passes contract rows through with roles intact", () => {
    const out = parseTranscript([
      {
        block: { kind: "text", text: "hi" },
        role: "user",
        id: "b1",
        seq: 0,
        generation: 0,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  it("an empty transcript is an empty list, not an error", () => {
    expect(parseTranscript([])).toEqual([]);
  });

  it("rejects rows with unknown block kinds", () => {
    expect(() =>
      parseTranscript([
        { block: { kind: "telepathy" }, role: "assistant", id: "b9", seq: 0, generation: 0 },
      ]),
    ).toThrow();
  });
});

describe("store running flag (review 30: setRunning had zero production callers)", () => {
  it("turnStart marks the thread running on success", async () => {
    vi.mocked(invoke).mockResolvedValue({ thread_id: "t1" });
    await turnStart(turnParams("t1"));
    expect(useThreadStore.getState().running).toContain("t1");
  });

  it("a rejected turnStart leaves the thread not-running (rollback)", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("provider refused"));
    await expect(turnStart(turnParams("t1"))).rejects.toThrow(/provider refused/);
    expect(useThreadStore.getState().running).not.toContain("t1");
  });

  it("turnStop clears the running flag", async () => {
    useThreadStore.getState().openThread("t1");
    useThreadStore.getState().setRunning("t1", true);
    vi.mocked(invoke).mockResolvedValue(true);
    await turnStop("t1");
    expect(useThreadStore.getState().running).not.toContain("t1");
  });

  it("questionAnswer marks the thread running on success", async () => {
    useThreadStore.getState().openThread("t1");
    vi.mocked(invoke).mockResolvedValue({ card_id: "call-q", resolved: "a" });
    await questionAnswer({
      threadId: "t1",
      toolCallId: "call-q",
      answer: "a",
      provider: "anthropic",
      model: "m",
      effort: "medium",
      maxTokens: 4096,
    });
    expect(useThreadStore.getState().running).toContain("t1");
  });

  it("a turn-done event clears the flag even after the view unmounts", async () => {
    // The done-clear lives in turn.ts (module scope), not the view: even if
    // ChatView is gone the flag must not stick at "working" forever. Uses a
    // unique id: the module-level sync registers once per thread.
    const id = "t-done-sync";
    useThreadStore.getState().openThread(id);
    useThreadStore.getState().setRunning(id, true);
    const doneHandlers: EnvelopeHandler[] = [];
    mockedListen.mockImplementation((name, cb) => {
      if (name === TURN_DONE) doneHandlers.push(cb as unknown as EnvelopeHandler);
      return Promise.resolve(() => {});
    });
    // Register the module-level done listener the way a real start does.
    vi.mocked(invoke).mockResolvedValue({ thread_id: id });
    await turnStart(turnParams(id));
    // The listener registers on a microtask inside listenTurnDone; let it
    // settle before asserting it exists.
    await vi.waitFor(() => {
      expect(doneHandlers).toHaveLength(1);
    });
    // Fire the terminal event for this thread. `listen` hands its callback an
    // envelope; the payload is what carries the done shape.
    doneHandlers[0]({
      payload: {
        thread_id: id,
        end: "EndTurn",
        dispatched: [],
        assistant_messages: 1,
        pending_approvals: [],
      },
    });
    expect(useThreadStore.getState().running).not.toContain(id);
  });
});

describe("streaming event filtering (review 30: the real filter had zero coverage)", () => {
  it("delivers only this thread's events, and drops malformed payloads", async () => {
    const seen: TurnEvent[] = [];
    const eventHandlers: EnvelopeHandler[] = [];
    mockedListen.mockImplementation((name, cb) => {
      if (name === TURN_EVENT) eventHandlers.push(cb as unknown as EnvelopeHandler);
      return Promise.resolve(() => {});
    });
    await listenTurnEvents("t1", (e) => seen.push(e));
    expect(eventHandlers).toHaveLength(1);
    const onEvent = eventHandlers[0];
    // Another thread's envelope: dropped.
    onEvent({
      payload: { thread_id: "t2", event: { type: "text_delta", index: 0, text: "other" } },
    });
    // Malformed payload: dropped, never thrown to the view.
    onEvent({ payload: { nonsense: true } });
    // Give the two drops a beat, then prove the real one lands.
    await Promise.resolve();
    expect(seen).toHaveLength(0);
    // Our own thread: delivered.
    onEvent({
      payload: { thread_id: "t1", event: { type: "text_delta", index: 0, text: "mine" } },
    });
    await vi.waitFor(() => {
      expect(seen).toEqual([{ type: "text_delta", index: 0, text: "mine" }]);
    });
  });
});

describe("turn done listener (review 30: dead thread_id guard)", () => {
  it("filters by thread and validates the payload", async () => {
    const seen: TurnDone[] = [];
    const doneHandlers: EnvelopeHandler[] = [];
    mockedListen.mockImplementation((name, cb) => {
      if (name === TURN_DONE) doneHandlers.push(cb as unknown as EnvelopeHandler);
      return Promise.resolve(() => {});
    });
    await listenTurnDone("t1", (d) => seen.push(d));
    expect(doneHandlers).toHaveLength(1);
    const onDone = doneHandlers[0];
    // Another thread: dropped.
    onDone({
      payload: { thread_id: "t2", end: "EndTurn", dispatched: [], assistant_messages: 1, pending_approvals: [] },
    });
    // Malformed: dropped, never thrown.
    onDone({ payload: { thread_id: "t1" } });
    expect(seen).toHaveLength(0);
    onDone({
      payload: { thread_id: "t1", end: "EndTurn", dispatched: [], assistant_messages: 1, pending_approvals: [] },
    });
    expect(seen).toHaveLength(1);
  });
});