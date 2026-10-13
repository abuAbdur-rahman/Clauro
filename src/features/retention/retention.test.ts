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
    expect(containsKeyMaterial("api_key = " + "abcdef1234567890abcdef1234567890")).toBe(true);
    expect(containsKeyMaterial("hello world")).toBe(false);
  });
  it("catches modern key shapes the old guard missed (review 31 #9)", () => {
    // The old `/sk-[A-Za-z0-9]{8,}/` stopped at the first `-`, so real keys
    // like sk-proj-… / sk-ant-api03-… never matched and shipped in exports.
    expect(containsKeyMaterial("sk-proj-Abc123Def456Ghi789Jkl012")).toBe(true);
    expect(containsKeyMaterial("Authorization: Bearer sk-ant-api03-Abc123Def456")).toBe(true);
    expect(containsKeyMaterial("echo sk-" + "abcdefghijklmnop")).toBe(true);
    // Prose that merely starts with "sk" stays exportable.
    expect(containsKeyMaterial("we shipped the skill-abcdefghij release")).toBe(false);
  });
});
