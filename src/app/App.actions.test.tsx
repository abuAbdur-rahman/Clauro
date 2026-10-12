// Task 032 U2 — App shell actions audit: every App-level button acts.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
});
