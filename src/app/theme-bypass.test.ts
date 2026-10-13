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
 * Review 61 P1 / review 32 (theme bypass): TitleBar, ArtifactDrawer,
 * ModelPicker, TranscriptView, Composer and ChatView hardcoded palette
 * values that ignore the theme — a near-black titlebar over a light shell,
 * raw ramp colours, a fixed white frame. Source-pinned, because a colour
 * class is a static property with no behaviour to observe: these sources
 * must express colour only through the token classes styles.css defines, and
 * must keep the token pairs they were converted to. `styles.css` itself is
 * deliberately NOT under test — its contrast pairs are locked by
 * features/ui/contrast.test.ts.
 */
const SOURCES: Readonly<Record<string, string>> = {
  TitleBar: "./TitleBar.tsx",
  ArtifactDrawer: "../components/ArtifactDrawer.tsx",
  ModelPicker: "../components/ModelPicker.tsx",
  TranscriptView: "../features/transcript/TranscriptView.tsx",
  Composer: "../components/Composer.tsx",
  ChatView: "../features/turn/ChatView.tsx",
};

const BYPASS: ReadonlyArray<readonly [string, RegExp]> = [
  ["the neutral ramp (theme-blind)", /neutral-\d/],
  ["a hex colour literal", /#[0-9a-fA-F]{3,8}\b/],
  ["an untokened white surface/text", /\b(?:bg|text|border)-white\b/],
  ["an off-grid type size", /text-\[\d+px\]/],
  ["a raw warning colour", /text-amber-\d/],
  ["a raw danger colour", /text-red-\d/],
];

const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  TitleBar: ["bg-background", "text-foreground", "text-muted-foreground", "hover:bg-destructive"],
  ArtifactDrawer: ["border-border", "text-foreground", "text-muted-foreground", "text-destructive"],
  ModelPicker: ["border-border", "text-muted-foreground", "text-destructive"],
  TranscriptView: [
    "text-foreground",
    "text-muted-foreground",
    "border-border",
    "text-warning",
    "text-destructive",
    "bg-secondary",
  ],
  Composer: ["text-muted-foreground", "border-border", "bg-card", "bg-popover", "bg-accent"],
  ChatView: [
    "text-foreground",
    "text-muted-foreground",
    "border-border",
    "bg-popover",
    "hover:bg-accent",
    "text-warning",
  ],
};

describe("no component bypasses the theme tokens (review 61 P1)", () => {
  for (const [name, rel] of Object.entries(SOURCES)) {
    it(`${name} carries no hardcoded palette`, () => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      for (const [what, pattern] of BYPASS) {
        expect(src, `${name} uses ${what}`).not.toMatch(pattern);
      }
      for (const token of REQUIRED[name]) {
        expect(src, `${name} no longer uses the ${token} token class`).toContain(token);
      }
    });
  }
});
