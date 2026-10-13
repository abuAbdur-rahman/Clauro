// @vitest-environment jsdom
/**
 * usetheme: pre-paint apply (review 31 #6 — "no flash of wrong theme" was
 * not delivered: the hook applied in useEffect, after the first frame) and
 * accent passthrough (review 31 #5 — the hook clobbered `dataset.accent`
 * with the hardcoded "neutral" every time mode/density changed, undoing
 * the picker's write).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/** jsdom has no matchMedia; the hook subscribes to one. */
function stubMedia(matches = false): void {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = "";
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.accent;
  stubMedia(false);
  vi.resetModules();
});

describe("usetheme pre-paint apply (review 31 #6)", () => {
  it("importing the module applies the stored theme before any render", async () => {
    window.localStorage.setItem("clauro.theme.mode", "dark");
    window.localStorage.setItem("clauro.theme.density", "compact");
    // The OS says light; the user's pinned dark still wins. No hook is
    // rendered — the class must be on <html> from module import alone.
    await import("./usetheme");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.density).toBe("compact");
  });

  it("skips cleanly on hosts without matchMedia (node-ish test envs)", async () => {
    // @ts-expect-error — deliberately removing the API the hook normally uses.
    delete window.matchMedia;
    window.localStorage.setItem("clauro.theme.mode", "dark");
    await expect(import("./usetheme")).resolves.toBeDefined();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("usetheme accent passthrough (review 31 #5)", () => {
  it("a mode change no longer clobbers the picked accent", async () => {
    window.localStorage.setItem("clauro.theme.accent", "#0f7b0f");
    const { useTheme } = await import("./usetheme");
    const { result } = renderHook(() => useTheme());
    // The hook's own apply re-asserts the stored accent, not "neutral".
    expect(document.documentElement.dataset.accent).toBe("#0f7b0f");
    act(() => {
      result.current.setMode("light");
    });
    expect(document.documentElement.dataset.accent).toBe("#0f7b0f");
    act(() => {
      result.current.setDensity("compact");
    });
    expect(document.documentElement.dataset.accent).toBe("#0f7b0f");
  });

  it("falls back to neutral when nothing was picked", async () => {
    const { useTheme } = await import("./usetheme");
    renderHook(() => useTheme());
    expect(document.documentElement.dataset.accent).toBe("neutral");
  });
});
