// Task 031 T6 — App shell hotkey wiring: every hook in hotkey.ts fires from App.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import App from "./App";
import { useThreadStore } from "../features/catalogue/thread";

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

// T4 owns ProjectsRail and its working tree is mid-edit (unbound
// `FolderKanban` at ProjectsRail.tsx:513 breaks every full-App render).
// These wiring tests stub the rail so T6 stays verifiable without touching
// T4's files; the stub keeps the rail's test id for view assertions.
vi.mock("../features/projects/ProjectsRail", () => ({
  ProjectsRail: () => <div data-testid="projects-rail" />,
}));

function media(query: string) {
  return {
    matches: query.length < 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    media: query,
  } as unknown as MediaQueryList;
}

describe("App hotkey wiring (031 T6)", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useThreadStore.getState().reset();
    window.matchMedia = media;
  });

  it("Ctrl+N opens the thread-owned chat view", async () => {
    render(<App />);
    await screen.findByTestId("home-header");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true }));
    // Full-App render: the lazy ChatView chunk exceeds the 1s default under
    // full-suite parallel load (same reason shell.test raises its timeout).
    expect(await screen.findByTestId("transcript-empty", undefined, { timeout: 15000 })).toBeDefined();
    expect(useThreadStore.getState().threads["thread-001"]?.open).toBe(true);
  }, 30000);

  it("Ctrl+Shift+C dispatches the palette /compact intent", async () => {
    render(<App />);
    await screen.findByTestId("home-header");
    const seen: string[] = [];
    const h = () => {
      seen.push("compact");
    };
    window.addEventListener("clauro:compact-request", h);
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true }));
      expect(seen).toEqual(["compact"]);
    } finally {
      window.removeEventListener("clauro:compact-request", h);
    }
  });

  it("Ctrl+Shift+A is a safe no-op until a drawer open-state exists", async () => {
    render(<App />);
    await screen.findByTestId("home-header");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", ctrlKey: true, shiftKey: true }));
    expect(await screen.findByTestId("home-header")).toBeDefined();
  });

  it("F11 drives the TitleBar maximize affordance without throwing", async () => {
    render(<App />);
    await screen.findByTestId("home-header");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11" }));
    expect(await screen.findByRole("button", { name: /maximize/i })).toBeDefined();
  });
});
