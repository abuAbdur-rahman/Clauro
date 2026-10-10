/** Task 029 — real must never import mock. Fails if App pulls `@/mock/*`. */
import { describe, expect, it } from "vitest";
import appSrc from "../app/App.tsx?raw";

describe("real boot isolation", () => {
  it("src/app/App.tsx imports zero @/mock modules", () => {
    expect(appSrc).not.toMatch(/@\/mock\//);
  });
});
