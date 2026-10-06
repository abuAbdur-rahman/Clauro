//! Task 020 failing tests first — palette states + theme.
import { describe, expect, it } from "vitest";
import { paletteActions, type PaletteState } from "./palette";
import { applyTheme, type Theme } from "./theme";

describe("020 palette", () => {
  it("palette blocked mid-turn with reason; /compact unavailable mid-turn", () => {
    const st: PaletteState = { turnRunning: true };
    const actions = paletteActions(st);
    expect(actions.blocked).toBe(true);
    expect(actions.reason).toMatch(/turn/i);
    expect(actions.available).not.toContain("/compact");
  });
  it("bash approval never a palette action; attach absent", () => {
    const actions = paletteActions({ turnRunning: false });
    expect(actions.available).not.toContain("bash:approve");
    expect(actions.available).not.toContain("attach");
  });
});

describe("020 theme", () => {
  it("light/dark/system resolve without flash value", () => {
    const t: Theme = { mode: "system", accent: "neutral", density: "comfortable" };
    expect(applyTheme(t, true)).toBe("dark");
    expect(applyTheme(t, false)).toBe("light");
    expect(applyTheme({ ...t, mode: "dark" }, false)).toBe("dark");
  });
});
