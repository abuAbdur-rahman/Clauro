/** Task 029 follow-up (B01) — custom titlebar. Fails until TitleBar.tsx exists. */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TitleBar } from "./TitleBar";

function matchMedia(query: string) {
  return {
    matches: query.length === 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList;
}

beforeEach(() => {
  cleanup();
  window.matchMedia = matchMedia;
});

describe("TitleBar", () => {
  it("renders a 32px drag bar with the app name and optional title", () => {
    const { rerender } = render(<TitleBar />);
    const bar = screen.getByTestId("app-titlebar");
    expect(bar.className).toContain("h-8");
    expect(bar.getAttribute("data-tauri-drag-region")).not.toBeNull();
    expect(screen.getByText("Clauro")).toBeDefined();
    rerender(<TitleBar title="First thread" />);
    expect(screen.getByText("First thread")).toBeDefined();
  });

  it("renders 46x32 caption buttons with accessible names", () => {
    render(<TitleBar />);
    for (const name of ["Minimize", "Maximize", "Close"] as const) {
      const btn = screen.getByRole("button", { name });
      expect(btn.className).toContain("w-[46px]");
      expect(btn.className).toContain("h-8");
    }
    expect(screen.getByRole("button", { name: "Close" }).className).toContain(
      "hover:bg-[#C42B1C]",
    );
  });

  it("caption clicks are silent no-ops without a Tauri runtime", async () => {
    render(<TitleBar />);
    for (const name of ["Minimize", "Maximize", "Close"] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    // Flush the dynamic-import microtasks; any rejection would fail the test.
    await vi.waitFor(() => {
      expect(screen.getByTestId("app-titlebar")).toBeDefined();
    });
  });
});
