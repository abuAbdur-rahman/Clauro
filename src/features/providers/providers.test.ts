/**
 * Provider bridge tests. Same rule as the turn bridge: every payload is
 * Zod-validated at the boundary, unknown shapes throw, the view shows a
 * notice. The invoke wrappers are thin by construction; these pin parsing.
 */
import { describe, expect, it } from "vitest";
import {
  parseEnrichedModels,
  parseModelsView,
  parseProviderList,
} from "./providers";

describe("parseProviderList", () => {
  it("parses configured providers with freshness and key status", () => {
    const out = parseProviderList([
      {
        id: "anthropic",
        display_name: "Anthropic",
        kind: "anthropic",
        base_url: null,
        model_count: 3,
        models_fetched_at: 1000,
        stale: false,
        has_key: true,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("anthropic");
    expect(out[0].has_key).toBe(true);
  });

  it("an empty list is the honest unconfigured state", () => {
    expect(parseProviderList([])).toEqual([]);
  });

  it("rejects garbage instead of rendering it", () => {
    expect(() => parseProviderList([{ id: "x" }])).toThrow();
    expect(() => parseProviderList("nope")).toThrow();
  });
});

describe("parseModelsView", () => {
  it("parses stored models with freshness", () => {
    const out = parseModelsView({
      provider_id: "anthropic",
      models: [{ id: "claude-x", display_name: "Claude X" }],
      models_fetched_at: 1000,
      stale: false,
    });
    expect(out.models).toHaveLength(1);
    expect(out.stale).toBe(false);
  });

  it("rejects garbage instead of rendering it", () => {
    expect(() => parseModelsView({ provider_id: "a" })).toThrow();
  });
});

describe("parseEnrichedModels", () => {
  it("parses known and unknown limits side by side", () => {
    const out = parseEnrichedModels([
      {
        id: "claude-x",
        display_name: "Claude X",
        limits_known: true,
        context_window: 200000,
        max_output: 8192,
        reasoning: true,
        tool_call: true,
      },
      {
        id: "mystery-1",
        display_name: "Mystery 1",
        limits_known: false,
        context_window: null,
        max_output: null,
        reasoning: false,
        tool_call: false,
      },
    ]);
    expect(out[0].limits_known).toBe(true);
    expect(out[0].context_window).toBe(200000);
    expect(out[1].limits_known).toBe(false);
    expect(out[1].context_window).toBeNull();
  });

  it("rejects garbage instead of rendering it", () => {
    expect(() => parseEnrichedModels([{ id: "x" }])).toThrow();
  });
});