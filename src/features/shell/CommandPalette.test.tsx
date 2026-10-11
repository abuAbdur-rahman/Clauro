// @vitest-environment jsdom
/**
 * Sectioned palette tests (prototype parity, index.html:516-524). Sections in
 * Actions/Chats/Projects/Settings order, ArrowUp/Down + Enter keyboard nav,
 * close on select, Esc/outside close via onOpenChange (the trap fix), and
 * built-in ids dispatching to real stores.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette";
import { groupPalette, itemSection, filterPalette, type PaletteItem } from "./palette";
import { useSettingsStore } from "./settings";
import { useThreadStore } from "../catalogue/thread";

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

beforeEach(() => {
  cleanup();
  useSettingsStore.getState().closeSettings();
  useThreadStore.getState().reset();
  window.localStorage.clear();
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
});

afterEach(() => {
  cleanup();
});

const CHATS = [{ id: "c1", title: "Debounce in React" }];
const PROJECTS = [{ id: "pr1", name: "Portfolio site" }];

describe("groupPalette", () => {
  it("orders Actions/Chats/Projects/Settings and drops empties", () => {
    const items: PaletteItem[] = [
      { id: "settings:general", tab: "actions", label: "General", section: "Settings" },
      { id: "chat:c1", tab: "chats", label: "Debounce" },
      { id: "action:new-chat", tab: "actions", label: "New chat", section: "Actions" },
    ];
    expect(groupPalette(items).map(([s]) => s)).toEqual(["Actions", "Chats", "Settings"]);
  });

  it("derives section from tab when unset", () => {
    expect(itemSection({ id: "x", tab: "projects", label: "P" })).toBe("Projects");
    expect(itemSection({ id: "y", tab: "actions", label: "A" })).toBe("Actions");
  });
});

describe("CommandPalette sections + search", () => {
  it("renders all four section headers in order with the hints footer", async () => {
    render(
      <CommandPalette
        state={{ turnRunning: false }}
        open={true}
        chats={CHATS}
        projects={PROJECTS}
      />,
    );
    const list = await screen.findByTestId("palette-list");
    const headers = within(list)
      .getAllByText(/^(Actions|Chats|Projects|Settings)$/)
      .map((h) => h.textContent);
    expect(headers).toEqual(["Actions", "Chats", "Projects", "Settings"]);
    expect(screen.getByText("Debounce in React")).toBeDefined();
    expect(screen.getByText("Portfolio site")).toBeDefined();
    expect(screen.getByText(/navigate.*enter select.*esc close/i)).toBeDefined();
  });

  it("filters across sections by query", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        state={{ turnRunning: false }}
        open={true}
        chats={CHATS}
        projects={PROJECTS}
      />,
    );
    await screen.findByTestId("palette-list");
    await user.type(screen.getByPlaceholderText(/search/i), "debounce");
    expect(screen.getByText("Debounce in React")).toBeDefined();
    expect(screen.queryByText("Portfolio site")).toBeNull();
  });

  it("shows recents alongside built-ins and keeps filterPalette tab behavior", () => {
    const recents: PaletteItem[] = [
      { id: "r1", tab: "chats", label: "Review tokenizer" },
      { id: "r2", tab: "projects", label: "Alpha" },
    ];
    expect(filterPalette(recents, "projects", "").map((i) => i.id)).toEqual(["r2"]);
    expect(filterPalette(recents, "all", "token").map((i) => i.id)).toEqual(["r1"]);
  });

  it("blocked mid-turn shows the reason", async () => {
    render(<CommandPalette state={{ turnRunning: true }} open={true} />);
    expect(await screen.findByText(/turn running/i)).toBeDefined();
  });
});

describe("CommandPalette html parity (031)", () => {
  it("shows a search icon in the search row", async () => {
    render(<CommandPalette state={{ turnRunning: false }} open={true} />);
    await screen.findByTestId("palette-list");
    const row = screen.getByTestId("palette-search-row");
    expect(row.querySelector("svg")).toBeTruthy();
  });

  it("keeps the dialog title screen-reader-only", async () => {
    render(<CommandPalette state={{ turnRunning: false }} open={true} />);
    await screen.findByTestId("palette-list");
    const title = document.querySelector('[data-slot="dialog-title"]');
    expect(title?.classList.contains("sr-only")).toBe(true);
  });

  it("renders section headers as uppercase group labels", async () => {
    render(
      <CommandPalette
        state={{ turnRunning: false }}
        open={true}
        chats={CHATS}
        projects={PROJECTS}
      />,
    );
    const list = await screen.findByTestId("palette-list");
    const headers = within(list).getAllByText(/^(Actions|Chats|Projects|Settings)$/);
    for (const h of headers) {
      expect(h.className).toMatch("uppercase");
    }
  });

  it("renders a leading icon in every item", async () => {
    render(
      <CommandPalette
        state={{ turnRunning: false }}
        open={true}
        chats={CHATS}
        projects={PROJECTS}
      />,
    );
    await screen.findByTestId("palette-list");
    for (const testid of [
      "palette-item-action:new-chat",
      "palette-item-chat:c1",
      "palette-item-project:pr1",
      "palette-item-settings:memory",
    ]) {
      expect(screen.getByTestId(testid).querySelector("svg")).toBeTruthy();
    }
  });

  it("hints footer uses kbd chips for the keys", async () => {
    render(<CommandPalette state={{ turnRunning: false }} open={true} />);
    await screen.findByTestId("palette-list");
    const footer = screen.getByTestId("palette-footer");
    const kbds = within(footer).getAllByText(/^(Enter|Esc)$/);
    expect(kbds).toHaveLength(2);
    for (const k of kbds) {
      expect(k.tagName).toBe("KBD");
    }
  });

  it("empty state pairs an icon with No results", async () => {
    const user = userEvent.setup();
    render(<CommandPalette state={{ turnRunning: false }} open={true} />);
    await screen.findByTestId("palette-list");
    await user.type(screen.getByPlaceholderText(/search/i), "zzz-no-such-thing");
    const empty = await screen.findByText("No results");
    expect(empty.closest("div")?.querySelector("svg")).toBeTruthy();
  });
});

describe("CommandPalette keyboard + close", () => {
  it("arrow nav + Enter selects, calls onAction, and closes", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        state={{ turnRunning: false }}
        open={true}
        chats={CHATS}
        projects={PROJECTS}
        onAction={onAction}
        onClose={onClose}
      />,
    );
    await screen.findByTestId("palette-list");
    await user.click(screen.getByPlaceholderText(/search/i));
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking an item selects and closes", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        state={{ turnRunning: false }}
        open={true}
        onAction={onAction}
        onClose={onClose}
      />,
    );
    await screen.findByTestId("palette-list");
    await user.click(screen.getByTestId("palette-item-action:new-chat"));
    expect(onAction).toHaveBeenCalledWith("action:new-chat");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes through onOpenChange (trap fix)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CommandPalette state={{ turnRunning: false }} open={true} onClose={onClose} />);
    await screen.findByTestId("palette-list");
    await user.click(screen.getByPlaceholderText(/search/i));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CommandPalette real actions", () => {
  it("new chat opens a thread in the thread store", async () => {
    const user = userEvent.setup();
    render(<CommandPalette state={{ turnRunning: false }} open={true} chats={CHATS} />);
    await screen.findByTestId("palette-list");
    await user.click(screen.getByTestId("palette-item-action:new-chat"));
    expect(Object.keys(useThreadStore.getState().threads)).toHaveLength(1);
  });

  it("open settings routes through the settings store", async () => {
    const user = userEvent.setup();
    render(<CommandPalette state={{ turnRunning: false }} open={true} />);
    await screen.findByTestId("palette-list");
    await user.click(screen.getByTestId("palette-item-action:open-settings"));
    expect(useSettingsStore.getState().open).toBe(true);
  });

  it("a settings entry opens the dialog on that page", async () => {
    const user = userEvent.setup();
    render(<CommandPalette state={{ turnRunning: false }} open={true} />);
    await screen.findByTestId("palette-list");
    await user.click(screen.getByTestId("palette-item-settings:memory"));
    expect(useSettingsStore.getState().open).toBe(true);
    expect(useSettingsStore.getState().section).toBe("memory");
  });

  it("opening a chat entry opens that thread id", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette state={{ turnRunning: false }} open={true} chats={CHATS} />,
    );
    await screen.findByTestId("palette-list");
    await user.click(screen.getByTestId("palette-item-chat:c1"));
    expect(useThreadStore.getState().threads["c1"]).toBeDefined();
  });

  it("compact dispatches an intent event for the turn owner", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    const h = () => {
      seen.push("compact");
    };
    window.addEventListener("clauro:compact-request", h);
    try {
      render(<CommandPalette state={{ turnRunning: false }} open={true} />);
      await screen.findByTestId("palette-list");
      await user.click(screen.getByTestId("palette-item-action:compact"));
      expect(seen).toEqual(["compact"]);
    } finally {
      window.removeEventListener("clauro:compact-request", h);
    }
  });
});
