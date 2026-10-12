// @vitest-environment jsdom
/**
 * Settings shell tests (UI-GUIDE §7). The dialog is a Dialog, not a page;
 * sections switch without reload; Appearance writes through to the theme;
 * Data exports a real download and blocks on key-shaped content. Eight pages
 * mirror the prototype; search filters the nav; every page has a data-testid.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SettingsDialog,
  SETTINGS_SHORTCUTS,
  filterSettingsSections,
  rowToExportBlock,
} from "./SettingsDialog";
import { useSettingsStore, type SettingsSection } from "../shell/settings";
import type { RenderRow } from "../transcript/types";

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

vi.mock("../providers/providers", () => ({
  providerList: vi.fn(),
  providerModelsEnriched: vi.fn(),
}));

vi.mock("../turn/turn", () => ({
  transcriptRead: vi.fn(),
}));

import { providerList } from "../providers/providers";
import { transcriptRead } from "../turn/turn";

function threadText(id: string, text: string): RenderRow {
  return { block: { kind: "text", text }, role: "assistant", id, seq: 0, generation: 0 };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(providerList).mockResolvedValue([]);
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

  it("accepts all eight sections", () => {
    const sections: SettingsSection[] = [
      "general",
      "appearance",
      "providers",
      "models",
      "memory",
      "data",
      "shortcuts",
      "about",
    ];
    for (const s of sections) {
      useSettingsStore.getState().openSettings(s);
      expect(useSettingsStore.getState().section).toBe(s);
    }
  });
});

describe("SettingsDialog", () => {
  it("renders nothing when closed, sections when open", async () => {
    render(<SettingsDialog threadId="t1" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    useSettingsStore.getState().openSettings();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    const nav = screen.getByTestId("settings-nav");
    expect(within(nav).getByRole("button", { name: "Providers" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Data" })).toBeTruthy();
  });

  it("shows all eight nav entries with a search box", () => {
    useSettingsStore.getState().openSettings("general");
    render(<SettingsDialog threadId="t1" />);
    const nav = screen.getByTestId("settings-nav");
    for (const label of [
      "General",
      "Appearance",
      "Providers",
      "Models",
      "Memory",
      "Data",
      "Shortcuts",
      "About",
    ]) {
      expect(within(nav).getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.getByRole("textbox", { name: /search settings/i })).toBeTruthy();
  });

  it("every page renders its data-testid", async () => {
    const pages: Array<[SettingsSection, string]> = [
      ["general", "settings-page-general"],
      ["appearance", "settings-page-appearance"],
      ["providers", "settings-page-providers"],
      ["models", "settings-page-models"],
      ["memory", "settings-page-memory"],
      ["data", "settings-page-data"],
      ["shortcuts", "settings-page-shortcuts"],
      ["about", "settings-page-about"],
    ];
    for (const [section, testid] of pages) {
      cleanup();
      useSettingsStore.getState().openSettings(section);
      render(<SettingsDialog threadId="t1" />);
      expect(await screen.findByTestId(testid)).toBeTruthy();
      useSettingsStore.getState().closeSettings();
    }
  });

  it("search filters the nav to matching sections", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("general");
    render(<SettingsDialog threadId="t1" />);
    await user.type(screen.getByRole("textbox", { name: /search settings/i }), "short");
    const nav = screen.getByTestId("settings-nav");
    expect(within(nav).queryByRole("button", { name: "General" })).toBeNull();
    expect(within(nav).getByRole("button", { name: "Shortcuts" })).toBeTruthy();
  });

  it("switches sections without reload", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("providers");
    render(<SettingsDialog threadId="t1" />);
    expect(screen.getByTestId("settings-page-providers")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(screen.queryByTestId("settings-page-providers")).toBeNull();
  });

  it("appearance mode persists the choice", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("appearance");
    render(<SettingsDialog threadId="t1" />);
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(window.localStorage.getItem("clauro.theme.mode")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("appearance has accent swatches, font slider, preview, density", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("appearance");
    render(<SettingsDialog threadId="t1" />);
    expect(screen.getByRole("button", { name: "Clay" })).toBeTruthy();
    expect(screen.getByLabelText("Chat font size")).toBeTruthy();
    expect(screen.getByText(/quick brown fox/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Blue" }));
    expect(window.localStorage.getItem("clauro.theme.accent")).toBe("#0067c0");
    expect(screen.getByRole("radio", { name: "Compact" })).toBeTruthy();
  });

  it("general page persists display name and send preference", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("general");
    render(<SettingsDialog threadId="t1" />);
    await user.type(screen.getByLabelText("Display name"), "Abu");
    expect(window.localStorage.getItem("clauro.prefs.name")).toBe("Abu");
    expect(screen.getByLabelText("Language")).toBeTruthy();
    expect(screen.getByLabelText("Send message with")).toBeTruthy();
    expect(screen.getByLabelText("Default system prompt")).toBeTruthy();
  });

  it("models page shows the honest empty state without providers", async () => {
    useSettingsStore.getState().openSettings("models");
    render(<SettingsDialog threadId="t1" />);
    expect(await screen.findByText(/no models/i)).toBeTruthy();
    expect(screen.getByLabelText("Default model")).toBeTruthy();
    expect(screen.getByLabelText("Temperature")).toBeTruthy();
  });

  it("memory adds, edits, and deletes entries in local state", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("memory");
    render(<SettingsDialog threadId="t1" />);
    expect(screen.getByText(/no memories yet/i)).toBeTruthy();
    await user.type(screen.getByLabelText("Add a memory"), "Prefers short answers");
    await user.click(screen.getByRole("button", { name: "Add memory" }));
    expect(screen.getByText("Prefers short answers")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /delete memory/i }));
    expect(screen.queryByText("Prefers short answers")).toBeNull();
  });

  it("shortcuts table lists kbd rows, about names the app", async () => {
    useSettingsStore.getState().openSettings("shortcuts");
    const { unmount } = render(<SettingsDialog threadId="t1" />);
    expect(await screen.findByTestId("settings-page-shortcuts")).toBeTruthy();
    expect(screen.getByText("Open command palette")).toBeTruthy();
    unmount();
    cleanup();
    useSettingsStore.getState().openSettings("about");
    render(<SettingsDialog threadId="t1" />);
    expect(await screen.findByTestId("settings-page-about")).toBeTruthy();
    expect(screen.getByText("0.1.0-prototype")).toBeTruthy();
  });

  it("shortcuts page renders every row with split kbd chips and a description", async () => {
    useSettingsStore.getState().openSettings("shortcuts");
    render(<SettingsDialog threadId="t1" />);
    const page = await screen.findByTestId("settings-page-shortcuts");
    // All eight prototype KEYS rows (html truth index.html:334).
    expect(SETTINGS_SHORTCUTS).toHaveLength(8);
    expect(within(page).getAllByRole("row")).toHaveLength(8);
    for (const [keys, desc] of SETTINGS_SHORTCUTS) {
      // Description column.
      expect(within(page).getByText(desc)).toBeTruthy();
      // One kbd chip per key part: "Ctrl+Shift+C" is three chips.
      for (const part of keys.split("+")) {
        const chips = within(page)
          .getAllByText(part, { selector: "kbd" });
        expect(chips.length).toBeGreaterThan(0);
      }
    }
    // Multi-key combos join chips with a bare "+" separator, never one chip.
    const combo = within(page).getByText("Toggle artifact panel").closest("tr");
    expect(combo?.querySelectorAll("kbd")).toHaveLength(3);
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
    window.URL.revokeObjectURL = vi.fn();
    useSettingsStore.getState().openSettings("data");
    render(<SettingsDialog threadId="t1" />);
    await user.click(screen.getByRole("button", { name: /export markdown/i }));
    await waitFor(() => {
      expect(screen.getByText(/blocked.*key material/i)).toBeTruthy();
    });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("data clears chats through the thread store", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("data");
    render(<SettingsDialog threadId="t1" />);
    await user.click(screen.getByRole("button", { name: /^Clear$/ }));
    expect(screen.getByText(/cleared all chats/i)).toBeTruthy();
    expect(screen.getByText(/local storage/i)).toBeTruthy();
  });
});

describe("SettingsDialog html parity (031)", () => {
  const NAV_LABELS = [
    "General",
    "Appearance",
    "Providers",
    "Models",
    "Memory",
    "Data",
    "Shortcuts",
    "About",
  ];

  it("pairs every nav entry with a lucide icon", () => {
    useSettingsStore.getState().openSettings("general");
    render(<SettingsDialog threadId="t1" />);
    const nav = screen.getByTestId("settings-nav");
    for (const label of NAV_LABELS) {
      const button = within(nav).getByRole("button", { name: label });
      expect(button.querySelector("svg")).toBeTruthy();
    }
  });

  it("keeps the dialog title screen-reader-only (no visible nav header)", () => {
    useSettingsStore.getState().openSettings("general");
    render(<SettingsDialog threadId="t1" />);
    const title = document.querySelector('[data-slot="dialog-title"]');
    expect(title?.textContent).toBe("Settings");
    expect(title?.classList.contains("sr-only")).toBe(true);
  });

  it("renders the active page heading at html h2 scale", () => {
    useSettingsStore.getState().openSettings("general");
    render(<SettingsDialog threadId="t1" />);
    const heading = screen.getByRole("heading", { level: 2, name: "General" });
    expect(heading.className).toMatch("text-xl");
  });

  it("marks the accent swatch with a lucide check, never a unicode tick", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("appearance");
    render(<SettingsDialog threadId="t1" />);
    await user.click(screen.getByRole("button", { name: "Blue" }));
    expect(screen.getByRole("button", { name: "Blue" }).querySelector("svg")).toBeTruthy();
    expect(screen.queryByText("✓")).toBeNull();
  });

  it("renders memory row actions as named icon buttons", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().openSettings("memory");
    render(<SettingsDialog threadId="t1" />);
    await user.type(screen.getByLabelText("Add a memory"), "Prefers short answers");
    await user.click(screen.getByRole("button", { name: "Add memory" }));
    const del = screen.getByRole("button", { name: /delete memory/i });
    const edit = screen.getByRole("button", { name: /edit memory/i });
    expect(del.querySelector("svg")).toBeTruthy();
    expect(edit.querySelector("svg")).toBeTruthy();
  });

  it("pairs the models empty state with an icon", async () => {
    useSettingsStore.getState().openSettings("models");
    render(<SettingsDialog threadId="t1" />);
    const empty = await screen.findByText(/no models/i);
    expect(empty.closest("div")?.querySelector("svg")).toBeTruthy();
  });
});

describe("filterSettingsSections", () => {
  it("matches labels and content keywords", () => {
    expect(filterSettingsSections("")).toHaveLength(8);
    expect(filterSettingsSections("short")).toEqual(["shortcuts"]);
    expect(filterSettingsSections("keyboard")).toEqual(["shortcuts"]);
    expect(filterSettingsSections("accent")).toEqual(["appearance"]);
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
