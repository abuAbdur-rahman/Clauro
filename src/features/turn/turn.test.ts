/**
 * Turn bridge tests (023 host obligation). The event channel is the only path
 * from a running turn to the view — these pin the parsing half, which is all
 * that is testable without a Tauri runtime. The invoke wrappers are thin by
 * construction, like `features/catalogue/catalogue.ts`.
 */
import { describe, expect, it } from "vitest";
import { parseTranscript, parseTurnDone, parseTurnEvent } from "./turn";

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