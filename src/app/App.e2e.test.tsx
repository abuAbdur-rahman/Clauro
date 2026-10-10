// Task 029 slice e2e (headless): full <App/> proves dual-mode shell parity.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
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

function media(query: string) {
  return {
    matches: query.length < 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    media: query,
  } as unknown as MediaQueryList;
}

describe("App dual-mode shell e2e", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useThreadStore.getState().reset();
    window.matchMedia = media;
  });

  it("renders titlebar with caption buttons above the rail", async () => {
    render(<App />);
    const bar = await screen.findByTestId("app-titlebar");
    expect(bar.getAttribute("data-tauri-drag-region")).not.toBeNull();
    expect(await screen.findByRole("button", { name: /minimize/i })).toBeDefined();
    expect(await screen.findByRole("button", { name: /maximize/i })).toBeDefined();
    expect(await screen.findByRole("button", { name: /close/i })).toBeDefined();
    expect(await screen.findByTestId("projects-rail")).toBeDefined();
  });

  it("rail thread rows carry the status indicator contract", async () => {
    render(<App />);
    const row = await screen.findByTestId("thread-row-thread-001");
    expect(["working", "done", "not-viewed", "idle"]).toContain(row.getAttribute("data-status"));
  });

  it("collapse persists to localStorage, not cookies", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /collapse sidebar/i }));
    expect(localStorage.getItem("clauro.sidebar")).toBe("0");
    expect(document.cookie).not.toContain("sidebar");
  });

  it("shell renders on theme tokens with the padded center column", async () => {
    render(<App />);
    await screen.findByTestId("projects-rail");
    const shell = document.querySelector(".bg-background");
    expect(shell).not.toBeNull();
    expect(shell?.classList.contains("text-foreground")).toBe(true);
    expect(shell?.classList.contains("text-neutral-300")).toBe(false);
  });

  it("home greets with the settings name and offers the four seed chips", async () => {
    render(<App />);
    expect(
      await screen.findByText(/good (morning|afternoon|evening), abu/i),
    ).toBeDefined();
    for (const chip of ["Explain a concept", "Draft an email", "Debug my code", "Plan a project"]) {
      expect(await screen.findByRole("button", { name: chip })).toBeDefined();
    }
  });

  it("home header carries the model picker slot", async () => {
    render(<App />);
    const header = await screen.findByTestId("home-header");
    expect(within(header).getByText(/no providers configured/i)).toBeDefined();
  });

  it("a chip fills the composer draft and focuses it", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Debug my code" }));
    const box = screen.getByLabelText("Message");
    expect(box instanceof HTMLTextAreaElement ? box.value : "").toBe("Debug my code");
    expect(document.activeElement).toBe(box);
  });

  it("sending from home opens the thread-owned chat view", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Message"), "hello clauro");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByTestId("transcript-empty")).toBeDefined();
    expect(useThreadStore.getState().threads["thread-001"]?.open).toBe(true);
  });

  it("providers opens as a modal, never an inline page", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App />);
    await screen.findByTestId("projects-rail");
    expect(screen.queryByTestId("providers-view")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Providers" }));
    expect(await screen.findByTestId("providers-view")).toBeDefined();
    // The old inline page had a Back affordance; the modal must not.
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("providers-view")).toBeNull();
  });
});
