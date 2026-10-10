/**
 * Provider bridge tests. Same rule as the turn bridge: every payload is
 * Zod-validated at the boundary, unknown shapes throw, the view shows a
 * notice. The invoke wrappers are thin by construction; these pin parsing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  isProviderFormValid,
  parseEnrichedModels,
  parseModelsView,
  parseProviderList,
  PROVIDER_PRESETS,
  providerAddCustom,
  slugifyProviderId,
} from "./providers";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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

describe("invoke wire keys", () => {
  // Same Tauri rule as the turn bridge: Rust `display_name`/`base_url`
  // arrive as camelCase JS keys. snake_case fails at runtime with a missing-
  // key refusal, not a type error.
  it("providerAddCustom sends camelCase keys exactly", async () => {
    vi.mocked(invoke).mockResolvedValue({
      id: "office",
      display_name: "Office",
      kind: "openai-compatible",
      base_url: "https://llm.office.example/v1",
      model_count: 0,
      models_fetched_at: null,
      stale: true,
      has_key: false,
    });
    await providerAddCustom({
      id: "office",
      displayName: "Office",
      baseUrl: "https://llm.office.example/v1",
    });
    expect(invoke).toHaveBeenCalledWith("provider_add_custom", {
      id: "office",
      displayName: "Office",
      baseUrl: "https://llm.office.example/v1",
    });
  });
});

describe("provider dialog contract", () => {
  // The add/edit dialog (ProvidersView) validates client-side before any
  // invoke runs (B23): name required, http(s) URL, key required except
  // ollama. Anthropic rides the host's fixed URL, so its base URL is
  // optional. The stored key is never echoed — the dialog only collects a
  // replacement, so the schema never needs the old key.
  it("presets autofill name and endpoint root per type", () => {
    expect(PROVIDER_PRESETS.openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(PROVIDER_PRESETS.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(PROVIDER_PRESETS.ollama.baseUrl).toBe("http://localhost:11434");
    expect(PROVIDER_PRESETS.custom.baseUrl).toBe("");
    expect(PROVIDER_PRESETS.anthropic.name).toBe("Anthropic");
  });

  it("accepts a complete hosted-provider form", () => {
    expect(
      isProviderFormValid({
        type: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        key: "sk-live",
      }),
    ).toBe(true);
  });

  it("rejects a blank name", () => {
    expect(
      isProviderFormValid({
        type: "openai",
        name: "   ",
        baseUrl: "https://api.openai.com/v1",
        key: "sk-live",
      }),
    ).toBe(false);
  });

  it("rejects a non-http(s) base URL for endpoint types", () => {
    expect(
      isProviderFormValid({
        type: "custom",
        name: "Office",
        baseUrl: "llm.office.example/v1",
        key: "sk-live",
      }),
    ).toBe(false);
    expect(
      isProviderFormValid({
        type: "custom",
        name: "Office",
        baseUrl: "https://llm.office.example/v1",
        key: "sk-live",
      }),
    ).toBe(true);
  });

  it("lets anthropic skip the base URL — the host pins its fixed endpoint", () => {
    expect(
      isProviderFormValid({ type: "anthropic", name: "Anthropic", baseUrl: "", key: "sk-ant" }),
    ).toBe(true);
  });

  it("requires a key except for ollama", () => {
    expect(
      isProviderFormValid({
        type: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        key: "  ",
      }),
    ).toBe(false);
    expect(
      isProviderFormValid({
        type: "ollama",
        name: "Ollama (local)",
        baseUrl: "http://localhost:11434",
        key: "",
      }),
    ).toBe(true);
  });

  it("allowBlankKey waives only the key rule — a bad URL still fails", () => {
    // Edit mode sends a blank key as "keep the stored one" (never echoed).
    expect(
      isProviderFormValid(
        { type: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", key: "" },
        { allowBlankKey: true },
      ),
    ).toBe(true);
    expect(
      isProviderFormValid(
        { type: "openai", name: "OpenAI", baseUrl: "not-a-url", key: "" },
        { allowBlankKey: true },
      ),
    ).toBe(false);
    expect(
      isProviderFormValid(
        { type: "openai", name: "", baseUrl: "https://api.openai.com/v1", key: "" },
        { allowBlankKey: true },
      ),
    ).toBe(false);
  });

  it("rejects garbage instead of enabling Save", () => {
    expect(isProviderFormValid(null)).toBe(false);
    expect(isProviderFormValid({ type: "nope", name: "x", baseUrl: "", key: "" })).toBe(false);
  });
});

describe("slugifyProviderId", () => {
  // Custom and ollama adds need a row id the dialog never asks for — it is
  // derived from the display name so Save has something honest to send.
  it("derives a lowercase dashed id from the display name", () => {
    expect(slugifyProviderId("Office Gateway")).toBe("office-gateway");
    expect(slugifyProviderId("  Team LLM (eu) ")).toBe("team-llm-eu");
  });

  it("falls back to custom when nothing usable remains", () => {
    expect(slugifyProviderId("   ")).toBe("custom");
    expect(slugifyProviderId("!!!")).toBe("custom");
  });
});