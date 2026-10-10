// Task 029 slice e2e (headless): full <App/> proves dual-mode shell parity.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import App from "./App";

vi.mock("../features/catalogue/catalogue", () => ({
  refreshCatalogue: () =>
    Promise.resolve({ state: "live", models: 1, catalogue: { providers: {} } }),
  shortError: (e: unknown) => String(e),
  webviewStatus: () => Promise.resolve({ kind: "present", version: "test" }),
}));

function media(query: string) {
  return {
    matches: query.length < 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    media: query,
  } as unknown as MediaQueryList;
}

describe("App dual-mode shell e2e", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    window.matchMedia = media;
  });

  it("renders titlebar with caption buttons above the rail", async () => {
    render(<App />);
    const bar = await screen.findByTestId("app-titlebar");
    expect(bar.getAttribute("data-tauri-drag-region")).not.toBeNull();
    expect(await screen.findByRole("button", { name: /minimize/i })).toBeDefined();
    expect(await screen.findByRole("button", { name: /maximize/i })).toBeDefined();
    expect(await screen.findByRole("button", { name: /close/i })).toBeDefined();
    expect(await screen.findByTestId("projects-rail")).toBeDefined();
  });

  it("rail thread rows carry the status indicator contract", async () => {
    render(<App />);
    const row = await screen.findByTestId("thread-row-thread-001");
    expect(["working", "done", "not-viewed", "idle"]).toContain(row.getAttribute("data-status"));
  });

  it("collapse persists to localStorage, not cookies", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /collapse sidebar/i }));
    expect(localStorage.getItem("clauro.sidebar")).toBe("0");
    expect(document.cookie).not.toContain("sidebar");
  });
});
