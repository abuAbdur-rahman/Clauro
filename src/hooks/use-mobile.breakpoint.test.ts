import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package (see contrast.test.ts)
import { readFileSync as readFileSyncUntyped } from "node:fs";
// @ts-expect-error type error without @types/node package (see contrast.test.ts)
import { fileURLToPath as fileURLToPathUntyped } from "node:url";

// This repo ships no @types/node; assert the two signatures this test uses so
// type-aware lint sees real types instead of `any` (AGENTS §5).
const readFileSync = readFileSyncUntyped as (path: string, encoding: "utf8") => string;
const fileURLToPath = fileURLToPathUntyped as (url: URL) => string;

/**
 * Review 61 P3: the hook said 768 while UI-GUIDE.md stated "Below 800px" —
 * two files, two numbers, and only one of them shipped. Pinned here so they
 * cannot drift apart again. Node env (no DOM needed), because `file:`
 * URLs are only real outside the jsdom environment — the behavioural half
 * lives in use-mobile.test.ts.
 */
describe("useIsMobile breakpoint (review 61 P3)", () => {
  it("the hook constant and the UI-GUIDE rule are the same number", () => {
    const hook = readFileSync(fileURLToPath(new URL("./use-mobile.ts", import.meta.url)), "utf8");
    const guide = readFileSync(fileURLToPath(new URL("../../UI-GUIDE.md", import.meta.url)), "utf8");
    const guideLine = guide.split("\n").find((l) => l.includes("Below"));
    const hookPx = hook.match(/MOBILE_BREAKPOINT = (\d+)/)?.[1];
    const guidePx = guideLine?.match(/(\d+)\s*px/)?.[1];
    expect(hookPx).toBeDefined();
    expect(guidePx).toBeDefined();
    expect(hookPx).toBe(guidePx);
  });
});
