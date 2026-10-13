// Task 032 U2 — App shell actions audit: every App-level button acts.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import App from "./App";
import { useThreadStore } from "../features/catalogue/thread";

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

vi.mock("../features/catalogue/catalogue", () => ({
  refreshCatalogue: () =>
    Promise.resolve({ state: "live", models: 1, catalogue: { providers: {} } }),
  shortError: (e: unknown) => String(e),
  webviewStatus: () => Promise.resolve({ kind: "present", version: "test" }),
}));

vi.mock("../features/turn/turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/turn/turn")>();
  return {
    ...actual,
    turnStart: vi.fn(),
    turnStop: vi.fn(),
    transcriptRead: () => Promise.resolve([]),
    questionAnswer: vi.fn(),
    artifactLatest: () => Promise.resolve(null),
    listenTurnEvents: () => Promise.resolve(() => {}),
    listenTurnDone: () => Promise.resolve(() => {}),
  };
});

vi.mock("../features/providers/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/providers/providers")>();
  return {
    ...actual,
    providerList: () => Promise.resolve([]),
    providerModelsEnriched: () => Promise.resolve([]),
  };
});

function media(query: string) {
  return {
    matches: query.length < 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    media: query,
  } as unknown as MediaQueryList;
}

describe("App shell actions (032 U2)", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useThreadStore.getState().reset();
    window.matchMedia = media;
  });

  it("rail New chat creates a thread and opens the chat view", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    await screen.findByTestId("projects-rail");
    const before = new Set(Object.keys(useThreadStore.getState().threads));
    await user.click(screen.getByRole("button", { name: /new chat/i }));
    expect(await screen.findByTestId("transcript-empty", undefined, { timeout: 15000 })).toBeDefined();
    const after = Object.keys(useThreadStore.getState().threads);
    const fresh = after.filter((id) => !before.has(id));
    expect(fresh.length).toBe(1);
    expect(useThreadStore.getState().threads[fresh[0]]?.open).toBe(true);
    expect(screen.getByTestId("app-titlebar").textContent).toContain("New chat");
  }, 30000);

  it("memory toggle flips the composer memory state", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Memory" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  }, 30000);

  it("New project opens the dialog and creates a project card", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /browse projects/i }));
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    expect(await screen.findByTestId("new-project-dialog")).toBeDefined();
    await user.type(screen.getByTestId("project-name-input"), "Field notes");
    await user.click(screen.getByTestId("create-project"));
    // Created projects render on both surfaces: the grid card + the rail row.
    const rows = await screen.findAllByText("Field notes");
    expect(rows.length).toBe(2);
  }, 30000);

  it("project Start chat stages the message and opens the chat view", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /browse projects/i }));
    const research = screen.getAllByRole("button", { name: "Research" });
    await user.click(research[research.length - 1]);
    await user.type(await screen.findByTestId("project-composer"), "hello project");
    await user.click(await screen.findByTestId("project-composer-send"));
    expect(await screen.findByTestId("transcript-empty", undefined, { timeout: 15000 })).toBeDefined();
    const drafts = useThreadStore.getState().drafts;
    expect(Object.values(drafts)).toContain("hello project");
  }, 30000);

  it("project rename + instructions save persist for the session (review 31 #13)", async () => {
    // App passed no onRename/onSaveInstructions: the title edit looked saved
    // and Save sat enabled forever. Both now land in a session edit map —
    // title bar, grid and rail follow, and instructions survive navigation.
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /browse projects/i }));
    const cards = screen.getAllByRole("button", { name: "Research" });
    await user.click(cards[cards.length - 1]);
    const title = screen.getByTestId<HTMLInputElement>("project-title");
    await user.clear(title);
    await user.type(title, "Research Lab");
    await user.tab();
    expect(screen.getByTestId("app-titlebar").textContent).toContain("Research Lab");
    await user.type(screen.getByTestId("project-instructions"), "Be terse.");
    await user.click(screen.getByTestId("project-instructions-save"));
    await user.click(screen.getByTestId("project-back"));
    const renamed = screen.getAllByRole("button", { name: "Research Lab" });
    expect(renamed.length).toBeGreaterThanOrEqual(1);
    await user.click(renamed[renamed.length - 1]);
    expect(screen.getByTestId<HTMLTextAreaElement>("project-instructions").value).toContain(
      "Be terse.",
    );
  }, 30000);
});

describe("App shell wiring (review 31)", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useThreadStore.getState().reset();
    window.matchMedia = media;
  });

  it("clauro:open-chat drives the view — existing id and fresh chat", async () => {
    // The palette dispatches intent; only the shell owns `view` (review 31,
    // CRITICAL 2). Without a listener the palette changed nothing on screen.
    const { act } = await import("@testing-library/react");
    render(<App />);
    await screen.findByTestId("projects-rail");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("clauro:open-chat", { detail: { threadId: "thread-001" } }),
      );
    });
    expect(
      await screen.findByTestId("transcript-empty", undefined, { timeout: 15000 }),
    ).toBeDefined();
    expect(screen.getByTestId("app-titlebar").textContent).toContain("First thread");
    const before = Object.keys(useThreadStore.getState().threads);
    act(() => {
      window.dispatchEvent(new CustomEvent("clauro:open-chat"));
    });
    expect(
      await screen.findByTestId("transcript-empty", undefined, { timeout: 15000 }),
    ).toBeDefined();
    const fresh = Object.keys(useThreadStore.getState().threads).filter(
      (id) => !before.includes(id),
    );
    expect(fresh).toHaveLength(1);
  }, 30000);

  it("clauro:open-project opens the project detail view", async () => {
    const { act } = await import("@testing-library/react");
    render(<App />);
    await screen.findByTestId("projects-rail");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("clauro:open-project", { detail: { id: "research" } }),
      );
    });
    expect(
      await screen.findByTestId("project-composer", undefined, { timeout: 15000 }),
    ).toBeDefined();
  }, 30000);

  it("rail pin/rename/delete act on the thread store — no placebo", async () => {
    // Review 31 CRITICAL 1: App passed no handlers and the rail defaulted them
    // to noops. Each menu item must move real state, and Delete must confirm
    // before anything disappears.
    const user = (await import("@testing-library/user-event")).default.setup();
    useThreadStore.getState().openThread("chat-wired");
    useThreadStore.getState().markUpdated("chat-wired", Date.now());
    render(<App />);
    // Pin lands the row in the PINNED bucket.
    await user.click(await screen.findByTestId("thread-menu-chat-wired"));
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(useThreadStore.getState().threads["chat-wired"]?.pinned).toBe(true);
    expect(screen.getByTestId("chat-group-PINNED")).toBeTruthy();
    // Open the row so the titlebar tracks this thread, then rename.
    await user.click(screen.getByTestId("thread-row-chat-wired"));
    await user.click(screen.getByTestId("thread-menu-chat-wired"));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByTestId("rename-input-chat-wired");
    await user.clear(input);
    await user.type(input, "Wired chat{Enter}");
    expect(useThreadStore.getState().threads["chat-wired"]?.title).toBe("Wired chat");
    expect(screen.getByTestId("app-titlebar").textContent).toContain("Wired chat");
    // Delete asks first; only the confirm hides the row.
    await user.click(screen.getByTestId("thread-menu-chat-wired"));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: /delete chat/i })).toBeTruthy();
    expect(useThreadStore.getState().threads["chat-wired"]?.removed).toBe(false);
    await user.click(screen.getByTestId("delete-thread-confirm"));
    expect(useThreadStore.getState().threads["chat-wired"]?.removed).toBe(true);
    await waitFor(() => {
      expect(screen.queryByTestId("thread-menu-chat-wired")).toBeNull();
    });
  }, 60000);

  it("rail Export downloads through the shared guarded helper", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const createObjectURL = vi.fn(() => "blob:mock");
    window.URL.createObjectURL = createObjectURL;
    window.URL.revokeObjectURL = vi.fn();
    useThreadStore.getState().openThread("chat-export");
    render(<App />);
    await user.click(await screen.findByTestId("thread-menu-chat-export"));
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it("palette lists rail chats and projects, and blocks mid-turn", async () => {
    // Review 31 IMPORTANT (also flagged by 30): the shell passed no
    // chats/projects and a hardcoded turnRunning:false, so the Chats/Projects
    // sections and the mid-turn block copy were unreachable in the real app.
    const user = (await import("@testing-library/user-event")).default.setup();
    useThreadStore.getState().openThread("chat-palette");
    render(<App />);
    const rail = await screen.findByTestId("projects-rail");
    // Exact name: /search/i also matches "ReSearch"-ish project labels.
    await user.click(within(rail).getByRole("button", { name: "Search" }));
    expect(
      await screen.findByTestId("palette-item-chat:chat-palette", undefined, { timeout: 15000 }),
    ).toBeTruthy();
    expect(screen.getByTestId("palette-item-project:research")).toBeTruthy();
    await user.keyboard("{Escape}");
    useThreadStore.getState().setRunning("chat-palette", true);
    // Re-summon via the shell hotkey — mid-turn the palette must show its
    // blocked reason instead of pretending actions are available.
    await user.keyboard("{Control>}k{/Control}");
    expect(
      await screen.findByText(/turn running — palette actions resume/i, undefined, {
        timeout: 15000,
      }),
    ).toBeTruthy();
  }, 60000);

  it("home attach is disabled-with-reason, not a noop (review 31)", async () => {
    render(<App />);
    const attach = await screen.findByRole("button", { name: /attach a file/i });
    expect((attach as HTMLButtonElement).disabled).toBe(true);
  }, 30000);

  it("clauro.memory.enabled pref drives the composer memory default", async () => {
    // The Memory pane's persisted flag used to have zero readers (review 31).
    localStorage.setItem("clauro.memory.enabled", "false");
    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Memory" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  }, 30000);
});
