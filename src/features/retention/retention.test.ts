//! Task 019 failing tests first — export + retention pure logic.
import { describe, expect, it } from "vitest";
import { stripThinkingForExport, containsKeyMaterial } from "./retention";

describe("019 export", () => {
  it("thinking blocks stripped, plain text kept", () => {
    const blocks = [
      { kind: "text", text: "hello" },
      { kind: "thinking", text: "secret reasoning", signature: "sig" },
      { kind: "tool_use", id: "u1", name: "fs", input: {} },
    ];
    const out = stripThinkingForExport(blocks);
    expect(out.some((b) => (b as { kind: string }).kind === "thinking")).toBe(false);
    expect(out.some((b) => (b as { kind: string }).kind === "text")).toBe(true);
  });
  it("no key material in export", () => {
    expect(containsKeyMaterial("api_key = abcdef1234567890abcdef1234567890")).toBe(true);
    expect(containsKeyMaterial("hello world")).toBe(false);
  });
});
