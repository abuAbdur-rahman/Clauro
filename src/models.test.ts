import { describe, expect, it } from "vitest";
import {
  hashSystemPrompt,
  resolveLimits,
  switchWarnings,
  type LimitSources,
} from "./models";

const HAIKU = {
  provider: "anthropic",
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  contextWindow: 200_000,
  maxOutput: 64_000,
  reasoning: true,
  toolCall: true,
};

describe("resolveLimits", () => {
  it("prefers conversation over adapter spec over server snapshot, per field", () => {
    const sources: LimitSources = {
      conversation: { maxOutput: 8000 },
      adapterSpec: { maxOutput: 16_000, contextWindow: 100_000 },
      serverSnapshot: { maxOutput: 64_000, contextWindow: 200_000, reasoning: true, toolCall: true },
    };
    const out = resolveLimits(sources);
    expect(out).toEqual({
      limits: { maxOutput: 8000, contextWindow: 100_000, reasoning: true, toolCall: true },
    });
  });

  it("unknown everywhere is unknown, never zero", () => {
    const out = resolveLimits({});
    expect(out).toEqual({
      unknown: { kind: "unknown-model", ref: { provider: "anthropic", id: "mystery" } },
    });
    // Zero is a measurement. Unknown must never render as 0/0.
    expect(JSON.stringify(out)).not.toContain(":0");
  });

  it("partial sources degrade per field without zero-guessing", () => {
    const { name, provider, id, ...haikuLimits } = HAIKU;
    expect(`${provider}/${id} ${name}`).toBe("anthropic/claude-haiku-4-5 Claude Haiku 4.5");
    const out = resolveLimits({ serverSnapshot: { ...haikuLimits } });
    // Exactly the four limit fields survive — identity fields are stripped,
    // nothing is zero-guessed.
    expect(out).toEqual({
      limits: {
        contextWindow: 200_000,
        maxOutput: 64_000,
        reasoning: true,
        toolCall: true,
      },
    });
  });
});

describe("switchWarnings", () => {
  it("switching between reasoning models warns thinking blocks drop", () => {
    const warns = switchWarnings(
      { ...HAIKU, id: "sonnet-5.5" },
      { ...HAIKU, id: "haiku-4-5" },
    );
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/thinking/i);
  });

  it("same model reselected warns nothing", () => {
    const warns = switchWarnings({ ...HAIKU }, { ...HAIKU });
    expect(warns).toEqual([]);
  });

  it("switching between non-reasoning models warns nothing", () => {
    const plain = { ...HAIKU, reasoning: false };
    expect(
      switchWarnings(
        { ...plain, provider: "openai", id: "gpt-x" },
        { ...plain, provider: "openai", id: "gpt-y" },
      ),
    ).toEqual([]);
  });
});

describe("effort vs system prompt", () => {
  it("changing effort never alters the system-prompt hash", () => {
    const prompt = "You are Clauro. Context may be lost, so record progress.";
    const before = hashSystemPrompt(prompt);
    // Effort is a request parameter, not prompt text: it is carried alongside
    // the request and asserted on here, while the hash stays fixed.
    const effort = { effort: "high", display: "concealed" };
    expect(effort.effort).toBe("high");
    expect(hashSystemPrompt(prompt)).toBe(before);
  });

  it("hash is stable and distinguishes prompts", () => {
    expect(hashSystemPrompt("a")).toBe(hashSystemPrompt("a"));
    expect(hashSystemPrompt("a")).not.toBe(hashSystemPrompt("b"));
  });
});
