/** Review 32 FYI — the Ctrl/Cmd+B sidebar shortcut: modifier parity + guards. */
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

function renderShell(): void {
  render(
    <SidebarProvider defaultOpen={true}>
      <ToggleProbe />
      <input data-testid="field" />
      <textarea data-testid="area" />
      <div data-testid="editable" contentEditable={true} />
    </SidebarProvider>,
  );
}

const state = (): string | null => screen.getByTestId("toggle").getAttribute("data-state");

beforeEach(() => {
  window.matchMedia = matchMedia;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("sidebar keyboard shortcut", () => {
  it("Ctrl+B toggles the sidebar", async () => {
    renderShell();
    expect(await screen.findByTestId("toggle")).toBeTruthy();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(state()).toBe("collapsed");
  });

  it("Cmd+B toggles the sidebar (macOS parity)", async () => {
    renderShell();
    expect(await screen.findByTestId("toggle")).toBeTruthy();
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(state()).toBe("collapsed");
  });

  it("Ctrl+B inside a text field does not toggle", async () => {
    renderShell();
    expect(await screen.findByTestId("toggle")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("field"), { key: "b", ctrlKey: true, bubbles: true });
    expect(state()).toBe("expanded");
  });

  it("Ctrl+B inside a textarea does not toggle", async () => {
    renderShell();
    expect(await screen.findByTestId("toggle")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("area"), { key: "b", ctrlKey: true, bubbles: true });
    expect(state()).toBe("expanded");
  });

  it("Ctrl+B inside an editable region does not toggle", async () => {
    renderShell();
    expect(await screen.findByTestId("toggle")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("editable"), { key: "b", ctrlKey: true, bubbles: true });
    expect(state()).toBe("expanded");
  });

  it("key auto-repeat does not toggle repeatedly", async () => {
    renderShell();
    expect(await screen.findByTestId("toggle")).toBeTruthy();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, repeat: true });
    expect(state()).toBe("expanded");
  });
});
