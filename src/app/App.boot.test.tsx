// Task 030 — boot skeleton: checking stage renders the shell-shaped splash,
// then home once the runtime check resolves.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let resolveBoot: ((v: { kind: "present"; version: string }) => void) | null = null;

vi.mock("../features/catalogue/catalogue", () => ({
  refreshCatalogue: () => Promise.resolve({ state: "live", models: 0, catalogue: { providers: {} } }),
  shortError: (e: unknown) => String(e),
  webviewStatus: () =>
    new Promise<{ kind: "present"; version: string }>((r) => {
      resolveBoot = r;
    }),
}));

function media(query: string) {
  return {
    matches: query.length < 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    media: query,
  } as unknown as MediaQueryList;
}

describe("App boot skeleton", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    window.matchMedia = media;
    resolveBoot = null;
  });

  it("shows the skeleton shell while checking, then home when ready", async () => {
    const { default: App } = await import("./App");
    render(<App />);
    expect(await screen.findByTestId("boot-skeleton")).toBeDefined();
    expect(screen.getByText("Starting Clauro…")).toBeDefined();
    resolveBoot?.({ kind: "present", version: "test" });
    expect(await screen.findByTestId("home-header")).toBeDefined();
    expect(screen.queryByTestId("boot-skeleton")).toBeNull();
  },
  // Lazy view chunks resolve post-render: exceeds the 5s default under
  // full-suite parallel load (passes in isolation in ~18s).
  30000);
});
