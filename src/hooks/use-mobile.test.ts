// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIsMobile } from "./use-mobile";

function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

describe("useIsMobile (review 61 P3)", () => {
  it("799px is mobile; 800px is not", () => {
    setViewport(799);
    const mobile = renderHook(() => useIsMobile());
    expect(mobile.result.current).toBe(true);
    mobile.unmount();

    setViewport(800);
    const desktop = renderHook(() => useIsMobile());
    expect(desktop.result.current).toBe(false);
  });
});
