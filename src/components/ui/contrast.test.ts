/**
 * WCAG contrast floor for the accent tokens (UI-GUIDE §10: text ≥ 4.5:1;
 * WCAG 1.4.11 non-text/UI ≥ 3:1). Review `32` / `61` P0: `--primary` was
 * live-measured at ≈3.1:1 against its own `--primary-foreground`.
 *
 * Pure math, no DOM: reads `src/styles.css`, resolves the `:root` (light) and
 * `.dark` custom properties, converts `#hex` / `oklch()` to relative luminance
 * (WCAG 2.x) and asserts every real fg/bg pair the accent participates in.
 * Composite pairs (hover/tint/selection) mirror how CSS resolves them: colour
 * channels composited over the backdrop at the given alpha. The file comes in
 * through `node:fs` because `styles.css?raw` returns EMPTY under vitest — the
 * Tailwind plugin consumes CSS `?raw` requests (measured LEN=0).
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

const cssPath = fileURLToPath(new URL("../../styles.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

// --- colour math -----------------------------------------------------------

type LinearRgb = readonly [number, number, number];

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Oklab→linear-sRGB (Björn Ottosson matrices), for `oklch(L C H)` values. */
function oklchToLinear(L: number, C: number, Hdeg: number): LinearRgb {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function hexToLinear(hex: string): LinearRgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
  ];
}

function parseColor(value: string): LinearRgb {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) return hexToLinear(`#${hex[1]}`);
  const oklch = value.trim().match(/^oklch\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)\s*\)$/);
  if (oklch) return oklchToLinear(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
  throw new Error(`unsupported colour value in styles.css: ${value}`);
}

function luminance(rgb: LinearRgb): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(a: LinearRgb, b: LinearRgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha composite (CSS `bg-primary/10` etc.): channels blended in sRGB space. */
function over(fg: LinearRgb, alpha: number, bg: LinearRgb): LinearRgb {
  const mix = (i: number): number =>
    alpha * linearToSrgb(fg[i]) + (1 - alpha) * linearToSrgb(bg[i]);
  return [srgbToLinear(mix(0)), srgbToLinear(mix(1)), srgbToLinear(mix(2))];
}

// --- token extraction ------------------------------------------------------

function blocksMatching(selector: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "g");
  for (const m of css.matchAll(re)) out.push(m[1]);
  return out;
}

function tokens(selector: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of blocksMatching(selector)) {
    for (const decl of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      map.set(decl[1], decl[2].trim());
    }
  }
  return map;
}

const light = tokens(":root");
const dark = tokens("\\.dark");

function color(t: Map<string, string>, name: string): LinearRgb {
  const raw = t.get(name);
  if (!raw) throw new Error(`token ${name} not found`);
  return parseColor(raw);
}

const TEXT = 4.5; // UI-GUIDE §10 / WCAG 1.4.3
const UI = 3; // WCAG 1.4.11 — rings, borders, dots

type Theme = { name: string; t: Map<string, string>; tintAlpha: number };

const themes: Theme[] = [
  { name: "light", t: light, tintAlpha: 0.32 }, // ::selection mix in styles.css
  { name: "dark", t: dark, tintAlpha: 0.45 },
];

describe.each(themes)("accent contrast ($name theme)", ({ t, tintAlpha }) => {
  const primary = color(t, "--primary");
  const primaryFg = color(t, "--primary-foreground");
  const background = color(t, "--background");
  const card = color(t, "--card");
  const sidebar = color(t, "--sidebar");
  const ring = color(t, "--ring");
  const foreground = color(t, "--foreground");

  it("text on primary surfaces ≥ 4.5:1 (send button, tooltip, badge, bubble)", () => {
    expect(contrast(primaryFg, primary)).toBeGreaterThanOrEqual(TEXT);
  });

  it("primary as text on the app background ≥ 4.5:1 (link variant, empty-state links)", () => {
    expect(contrast(primary, background)).toBeGreaterThanOrEqual(TEXT);
  });

  it("primary as text on cards ≥ 4.5:1", () => {
    expect(contrast(primary, card)).toBeGreaterThanOrEqual(TEXT);
  });

  it("primary as text on bg-primary/10 tint ≥ 4.5:1 (tinted bubble)", () => {
    expect(contrast(primary, over(primary, 0.1, background))).toBeGreaterThanOrEqual(TEXT);
  });

  it("primary-foreground on hover:bg-primary/90 ≥ 4.5:1", () => {
    expect(contrast(primaryFg, over(primary, 0.9, background))).toBeGreaterThanOrEqual(TEXT);
  });

  it("focus ring against the background ≥ 3:1 (UI component)", () => {
    expect(contrast(ring, background)).toBeGreaterThanOrEqual(UI);
  });

  it("primary fills against the sidebar ≥ 3:1 (rail dots and active bar)", () => {
    expect(contrast(primary, sidebar)).toBeGreaterThanOrEqual(UI);
  });

  it("progress fill vs its bg-primary/20 track ≥ 3:1 (UI component)", () => {
    expect(contrast(primary, over(primary, 0.2, background))).toBeGreaterThanOrEqual(UI);
  });

  it("selected text (selection tint) vs foreground ≥ 4.5:1", () => {
    expect(contrast(foreground, over(primary, tintAlpha, background))).toBeGreaterThanOrEqual(
      TEXT,
    );
  });

  it("baseline body text on the background ≥ 4.5:1", () => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(TEXT);
  });

  it("muted-foreground text on the background ≥ 4.5:1 (hints, statuses)", () => {
    // The floor Composer's token-hint test used to check by ramp class
    // (review 33/61): muted-foreground IS the dim-text slot, and it must
    // clear the text floor in both themes.
    const mutedFg = color(t, "--muted-foreground");
    expect(contrast(mutedFg, background)).toBeGreaterThanOrEqual(TEXT);
  });

  it("warning as text on background and cards ≥ 4.5:1 (working/error lines)", () => {
    // The theme-bypass swap routes every amber status line through
    // --warning (reference --warn: #9d5d00 / #e0a040); it must read in
    // BOTH themes, which is exactly what the raw amber-400 class could not
    // do in light mode (review 61 P1).
    const warning = color(t, "--warning");
    expect(contrast(warning, background)).toBeGreaterThanOrEqual(TEXT);
    expect(contrast(warning, card)).toBeGreaterThanOrEqual(TEXT);
  });
});

/**
 * Stylesheet contracts jsdom cannot compute (it applies no CSS at all), so the
 * colour pairs above cover the numbers and these cover *which rules carry
 * them*: the composer focus ring must not be wired to a caller's aria-label
 * string (review 32 NIT / 61 P3), and the one component whose global outline
 * is suppressed must carry the full-opacity ring, never the 50% blend that
 * measures below 3:1 in both themes.
 */
describe("focus-style contract (review 32 NIT / 61 P3)", () => {
  it("global CSS suppresses the outline on the textarea slot, not on an aria-label value", () => {
    expect(css).not.toContain('textarea[aria-label="Message"]');
    expect(css).toContain('textarea[data-slot="textarea"]:focus-visible');
  });

  it("ui/Textarea's own focus ring is the full --ring token, not the /50 blend", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./textarea.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("focus-visible:ring-ring ");
    // The D112 comment inside textarea.tsx legitimately mentions the old class.
    expect(source).not.toContain("focus-visible:ring-ring/50");
  });
});
