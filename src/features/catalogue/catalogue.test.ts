import { describe, expect, it } from "vitest";
import { parseCataloguePayload, shortError } from "./catalogue";

describe("parseCataloguePayload", () => {
  it("parses a live catalogue with models and limits", () => {
    const out = parseCataloguePayload({
      state: "live",
      models: 2,
      catalogue: {
        providers: {
          anthropic: [
            {
              id: "claude-haiku-4-5",
              name: "Claude Haiku 4.5",
              context_window: 200000,
              max_output: 64000,
              reasoning: true,
              tool_call: true,
            },
          ],
        },
      },
    });
    expect(out.state).toBe("live");
    if (out.state === "live" || out.state === "cached") {
      expect(out.catalogue.providers["anthropic"][0].context_window).toBe(200_000);
    }
  });

  it("parses cached state with its notice intact", () => {
    const out = parseCataloguePayload({
      state: "cached",
      models: 1,
      catalogue: { providers: {} },
      notice: "fetch failed: dns",
    });
    expect(out.state).toBe("cached");
    if (out.state === "cached") expect(out.notice).toMatch(/dns/);
  });

  it("parses the honest empty state", () => {
    expect(parseCataloguePayload({ state: "absent" })).toEqual({ state: "absent" });
  });

  it("rejects garbage instead of rendering it", () => {
    expect(() => parseCataloguePayload({ state: "live", models: "many" })).toThrow();
  });
});

describe("shortError", () => {
  it("truncates walls of text for UI display", () => {
    expect(shortError(new Error("x".repeat(500))).length).toBeLessThan(250);
    expect(shortError("boom")).toBe("boom");
  });
});
