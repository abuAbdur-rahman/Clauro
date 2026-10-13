/**
 * Density must actually reach the root size (Task 020: "density applies
 * live").
 *
 * `html { font-size: 17px }` sits unlayered near the top of `styles.css`;
 * the compact rule was written inside `@layer base`. Unlayered author CSS
 * outranks any `@layer` regardless of specificity, so while the two rules
 * live in different cascade contexts the `data-density="compact"` attribute
 * applies but the root never resizes — observed in a real engine on
 * 2026-10-13 (attribute present, root stuck at 17px) after the unit suite
 * stayed green over it. jsdom's cascade ignores layers, so the invariant is
 * asserted structurally: both rules unlayered, where specificity
 * (`html[data-density]` > `html`) picks the winner.
 */
// @ts-expect-error type error without @types/node package (see vite.config.ts)
import { readFileSync as readFileSyncUntyped } from "node:fs";
// @ts-expect-error type error without @types/node package (see vite.config.ts)
import { fileURLToPath as fileURLToPathUntyped } from "node:url";

import { describe, expect, it } from "vitest";

// This repo ships no @types/node, so the node imports above are error-typed.
// Assert only the two signatures this test uses — type-aware lint then sees
// real types instead of `any`, so every call site stays checked (AGENTS §5:
// no `any`, no `eslint-disable`).
const readFileSync = readFileSyncUntyped as (
  path: string,
  encoding: "utf8",
) => string;
const fileURLToPath = fileURLToPathUntyped as (url: URL) => string;

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("styles.css density cascade", () => {
  it("keeps the root font size and the compact rule in the same (unlayered) context", () => {
    const layerBase = css.indexOf("@layer base {");
    const rootSize = css.indexOf("font-size: 17px");
    const compact = css.indexOf('html[data-density="compact"]');
    expect(layerBase).toBeGreaterThan(-1);
    expect(rootSize).toBeGreaterThan(-1);
    expect(compact).toBeGreaterThan(-1);
    // Both rules must precede the first layer: unlayered author CSS is not
    // subject to layer order, so the attribute selector's specificity decides
    // and the compact setting wins. Inside the layer it would lose silently.
    expect(rootSize).toBeLessThan(layerBase);
    expect(compact).toBeLessThan(layerBase);
  });
});
