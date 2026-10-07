// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import App from "./App";

vi.mock("../features/catalogue/catalogue", () => ({
  refreshCatalogue: () =>
    Promise.resolve({
      state: "live",
    models: 1,
    catalogue: {
      providers: {
        local: [
          {
            id: "tiny-8k",
            name: "Tiny",
            context_window: 8192,
            max_output: 2048,
            reasoning: false,
            tool_call: false,
          },
        ],
      },
    },
  }),
  shortError: (e: unknown) => String(e),
  webviewStatus: () => Promise.resolve({ kind: "present", version: "test" }),
}));

describe("App shell wires Phase 5", () => {
  beforeEach(() => {
    cleanup();
  });
  it("shows projects rail and composer; palette opens on Ctrl+K", async () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query.length < 0,
        addEventListener: () => {},
        removeEventListener: () => {},
        media: query,
      }) as unknown as MediaQueryList;
    render(<App />);
    expect(await screen.findByLabelText("projects")).toBeDefined();
    expect(await screen.findByRole("button", { name: /send/i })).toBeDefined();
    expect(screen.queryByLabelText("command palette")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(await screen.findByLabelText("command palette")).toBeDefined();
  });
  it("navigates home -> projects -> detail", async () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query.length < 0,
        addEventListener: () => {},
        removeEventListener: () => {},
        media: query,
      }) as unknown as MediaQueryList;
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /browse projects/i }));
    expect(await screen.findByRole("button", { name: /new project/i })).toBeDefined();
    const research = screen.getAllByRole("button", { name: "Research" });
    await user.click(research[research.length - 1]);
    expect(await screen.findByText(/project capacity used/i)).toBeDefined();
  });
});
