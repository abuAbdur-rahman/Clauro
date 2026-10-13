// @vitest-environment jsdom
/**
 * Review 32 (startup perf): React.lazy fetches a chunk the moment its
 * component first renders, so an always-mounted-but-closed overlay pulls its
 * chunk during boot. Mount each overlay on first open instead — nothing
 * visible changes (a closed overlay renders nothing either way), and once
 * opened they stay mounted so close/reopen never re-suspends.
 *
 * The drawer is stubbed: the behaviour under test is WHEN it mounts, and a
 * full-App render should not run a real prepare to find that out.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { useSettingsStore } from "../features/shell/settings";
import { useDrawerStore } from "../features/artifact/store";

const chunks = vi.hoisted(() => ({ palette: vi.fn(), settings: vi.fn() }));

vi.mock("../features/shell/CommandPalette", async (importOriginal) => {
  chunks.palette();
  return importOriginal<typeof import("../features/shell/CommandPalette")>();
});
vi.mock("../features/settings/SettingsDialog", async (importOriginal) => {
  chunks.settings();
  return importOriginal<typeof import("../features/settings/SettingsDialog")>();
});
vi.mock("../components/ArtifactDrawer", () => ({
  ArtifactDrawer: (props: { threadId: string }) => (
    <aside aria-label="artifact drawer" data-thread={props.threadId} />
  ),
}));
vi.mock("../features/catalogue/catalogue", () => ({
  refreshCatalogue: () =>
    Promise.resolve({
      state: "live",
      models: 1,
      catalogue: {
        providers: {
          local: [{ id: "tiny-8k", name: "Tiny", context_window: 8192, max_output: 2048 }],
        },
      },
    }),
  shortError: (e: unknown) => String(e),
  webviewStatus: () => Promise.resolve({ kind: "present", version: "test" }),
}));

function media(query: string) {
  return {
    matches: query.length < 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    media: query,
  } as unknown as MediaQueryList;
}

describe("lazy overlays mount on first open (review 32)", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.matchMedia = media;
    useSettingsStore.getState().closeSettings();
    useDrawerStore.getState().reset();
  });

  it("loads no overlay chunk at boot, then mounts each overlay on first open", async () => {
    render(<App />);
    expect(await screen.findByTestId("home-header", undefined, { timeout: 15000 })).toBeDefined();

    // Boot: the three chunks are untouched, and the never-opened drawer has
    // left no chrome behind (its closed render is a zero-width aside).
    expect(chunks.palette).not.toHaveBeenCalled();
    expect(chunks.settings).not.toHaveBeenCalled();
    expect(document.querySelector('aside[aria-label="artifact drawer"]')).toBeNull();

    // Settings: first open resolves the chunk; close and reopen must NOT
    // resolve it again (the component stays mounted once opened).
    act(() => {
      useSettingsStore.getState().openSettings("general");
    });
    await waitFor(
      () => {
        expect(chunks.settings).toHaveBeenCalledOnce();
      },
      { timeout: 15000 },
    );
    act(() => {
      useSettingsStore.getState().closeSettings();
    });
    act(() => {
      useSettingsStore.getState().openSettings("general");
    });
    expect(chunks.settings).toHaveBeenCalledOnce();

    // Palette: summoned by its hotkey, one load, content rendered.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await waitFor(
      () => {
        expect(chunks.palette).toHaveBeenCalledOnce();
      },
      { timeout: 15000 },
    );
    expect(
      await screen.findByLabelText("command palette", undefined, { timeout: 15000 }),
    ).toBeDefined();

    // Drawer: mounts when the active thread gets an artifact row (D121) —
    // with the same threadId the shell passes to it.
    act(() => {
      useDrawerStore.getState().setCompiling("thread-001", "a1");
    });
    await waitFor(() => {
      const aside = document.querySelector('aside[aria-label="artifact drawer"]');
      expect(aside?.getAttribute("data-thread")).toBe("thread-001");
    });
  }, 30000);
});
