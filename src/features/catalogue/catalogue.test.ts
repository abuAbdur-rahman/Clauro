import { describe, expect, it } from "vitest";
import { parseCataloguePayload, shortError } from "./catalogue";
// @ts-expect-error type error without @types/node package (see contrast.test.ts)
import { readFileSync as readFileSyncUntyped } from "node:fs";
// @ts-expect-error type error without @types/node package (see contrast.test.ts)
import { fileURLToPath as fileURLToPathUntyped } from "node:url";

// This repo ships no @types/node; assert the two signatures this test uses so
// type-aware lint sees real types instead of `any` (AGENTS §5).
const readFileSync = readFileSyncUntyped as (path: string, encoding: "utf8") => string;
const fileURLToPath = fileURLToPathUntyped as (url: URL) => string;

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

/**
 * Review 13 item 3 deleted `keyring_store`/`keyring_retrieve` host-side as
 * pure attack surface; the frontend wrappers that invoked them were dead
 * (nobody called them) and their removal is what lets the Rust contract test
 * retire its `FRONTEND_DRIFT` allowlist entries. Source-pinned, because a
 * barrel export is a contract with no behavioural surface to test: if the
 * command name comes back into this file, the drift is back too.
 */
describe("the deleted generic keyring commands stay deleted (review 13 item 3)", () => {
  it("catalogue.ts no longer references the removed commands", () => {
    const source = readFileSync(fileURLToPath(new URL("./catalogue.ts", import.meta.url)), "utf8");
    expect(source).not.toContain("keyring_store");
    expect(source).not.toContain("keyring_retrieve");
  });

  it("the feature barrel no longer exports the dead wrappers", () => {
    const barrel = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(barrel).not.toContain("keyringStore");
    expect(barrel).not.toContain("keyringRetrieve");
  });
});
