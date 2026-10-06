import { describe, expect, it } from "vitest";

/**
 * Task 002: prove the web test runner before any UI exists.
 * One trivial test — the runner, not the product, is under test.
 */
describe("workspace skeleton", () => {
  it("runs headless with no display and no webview", () => {
    // Default vitest environment is node: no DOM, no webview.
    // Absence of `window` is the assertion — the suite must not need one.
    expect(typeof window).toBe("undefined");
    expect(1 + 1).toBe(2);
  });
});
