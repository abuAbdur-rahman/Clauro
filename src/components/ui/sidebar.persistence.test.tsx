/** Task 029 slice 3 (B04) — sidebar collapse persists via localStorage, not cookies. */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SidebarProvider, useSidebar } from "./sidebar";

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

function matchMedia(query: string) {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    media: query,
  } as unknown as MediaQueryList;
}

function ToggleProbe(): React.JSX.Element {
  const { state, toggleSidebar } = useSidebar();
  return (
    <button type="button" data-testid="toggle" data-state={state} onClick={toggleSidebar}>
      toggle
    </button>
  );
}

beforeEach(() => {
  window.matchMedia = matchMedia;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("sidebar persistence", () => {
  it("writes collapse to localStorage (not a cookie)", async () => {
    render(
      <SidebarProvider defaultOpen={true}>
        <ToggleProbe />
      </SidebarProvider>,
    );
    expect((await screen.findByTestId("toggle")).getAttribute("data-state")).toBe("expanded");
    fireEvent.click(screen.getByTestId("toggle"));
    expect(screen.getByTestId("toggle").getAttribute("data-state")).toBe("collapsed");
    expect(window.localStorage.getItem("clauro.sidebar")).toBe("0");
    expect(document.cookie).not.toContain("sidebar_state");
  });

  it("reads collapse from localStorage on init", async () => {
    window.localStorage.setItem("clauro.sidebar", "0");
    render(
      <SidebarProvider defaultOpen={true}>
        <ToggleProbe />
      </SidebarProvider>,
    );
    expect((await screen.findByTestId("toggle")).getAttribute("data-state")).toBe("collapsed");
  });

  it("controlled mode leaves persistence to the caller (no local write)", async () => {
    const onOpenChange = vi.fn();
    render(
      <SidebarProvider open={true} onOpenChange={onOpenChange}>
        <ToggleProbe />
      </SidebarProvider>,
    );
    expect((await screen.findByTestId("toggle")).getAttribute("data-state")).toBe("expanded");
    fireEvent.click(screen.getByTestId("toggle"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(window.localStorage.getItem("clauro.sidebar")).toBeNull();
  });

  it("survives an unreadable store without throwing", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(
      <SidebarProvider defaultOpen={true}>
        <ToggleProbe />
      </SidebarProvider>,
    );
    expect((await screen.findByTestId("toggle")).getAttribute("data-state")).toBe("expanded");
    fireEvent.click(screen.getByTestId("toggle"));
    expect(screen.getByTestId("toggle").getAttribute("data-state")).toBe("collapsed");
  });
});
