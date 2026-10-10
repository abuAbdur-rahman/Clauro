// @vitest-environment jsdom
/**
 * Settings shell tests (UI-GUIDE §7). The dialog is a Dialog, not a page;
 * sections switch without reload; Appearance writes through to the theme;
 * Data exports a real download and blocks on key-shaped content.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog, rowToExportBlock } from "./SettingsDialog";
import { useSettingsStore } from "../shell/settings";
import type { RenderRow } from "../transcript/types";

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

vi.mock("../providers/ProvidersView", () => ({
  ProvidersView: () => <div data-testid="providers-pane-stub" />,
}));

vi.mock("../turn/turn", () => ({
  transcriptRead: vi.fn(),
}));

import { transcriptRead } from "../turn/turn";

function threadText(id: string, text: string): RenderRow {
  return { block: { kind: "text", text }, role: "assistant", id, seq: 0, generation: 0 };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSettingsStore.getState().closeSettings();
  window.localStorage.clear();
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
});

describe("settings store", () => {
  it("opens on a section and closes", () => {
    expect(useSettingsStore.getState().open).toBe(false);
    useSettingsStore.getState().openSettings("appearance");
    expect(useSettingsStore.getState().open).toBe(true);
    expect(useSettingsStore.getState().section).toBe("appearance");
    useSettingsStore.getState().closeSettings();
    expect(useSettingsStore.getState().open).toBe(false);
  });
});

describe("SettingsDialog", () => {
  it("renders nothing when closed, sections when open", async () => {
    render(<SettingsDialog threadId="t1" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    useSettingsStore.getState().openSettings();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Providers")).toBeTruthy();
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByText("Data")).toBeTruthy();
  });

  it("switches sections without reload", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("providers");
    render(<SettingsDialog threadId="t1" />);
    expect(screen.getByTestId("providers-pane-stub")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(screen.queryByTestId("providers-pane-stub")).toBeNull();
  });

  it("appearance mode persists the choice", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("appearance");
    render(<SettingsDialog threadId="t1" />);
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(window.localStorage.getItem("clauro.theme.mode")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("export downloads markdown with thinking stripped", async () => {
    const user = userEvent.setup();
    vi.mocked(transcriptRead).mockResolvedValue([
      threadText("b1", "kept answer"),
      {
        block: { kind: "thinking", text: "dropped", signature: "s", display: "full" },
        role: "assistant",
        id: "b2",
        seq: 1,
        generation: 0,
      },
    ]);
    const urls: string[] = [];
    const createObjectURL = vi.fn(() => {
      const url = "blob:mock";
      urls.push(url);
      return url;
    });
    window.URL.createObjectURL = createObjectURL;
    window.URL.revokeObjectURL = vi.fn();
    useSettingsStore.getState().openSettings("data");
    render(<SettingsDialog threadId="t1" />);
    await user.click(screen.getByRole("button", { name: /export markdown/i }));
    await waitFor(() => {
      expect(screen.getByText(/exported 2 blocks/i)).toBeTruthy();
    });
    expect(urls).toHaveLength(1);
  });

  it("export blocks on key-shaped content instead of writing", async () => {
    const user = userEvent.setup();
    // Deliberately low-entropy: trips our own scanner, trips no real one.
    vi.mocked(transcriptRead).mockResolvedValue([
      threadText("b1", "config line: api_key=not-a-real-key"),
    ]);
    const createObjectURL = vi.fn((): string => "blob:mock");
    window.URL.createObjectURL = createObjectURL;
    useSettingsStore.getState().openSettings("data");
    render(<SettingsDialog threadId="t1" />);
    await user.click(screen.getByRole("button", { name: /export markdown/i }));
    await waitFor(() => {
      expect(screen.getByText(/blocked.*key material/i)).toBeTruthy();
    });
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("rowToExportBlock", () => {
  it("maps every kind to readable text", () => {
    expect(
      rowToExportBlock(threadText("b1", "hi")),
    ).toEqual({ kind: "text", text: "hi" });
    expect(
      rowToExportBlock({
        block: { kind: "tool_result", tool_use_id: "c", status: "ok", preview: "out" },
        role: "assistant",
        id: "b2",
        seq: 1,
        generation: 0,
      }).text,
    ).toBe("out");
  });
});
