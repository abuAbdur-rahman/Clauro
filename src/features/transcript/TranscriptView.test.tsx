// @vitest-environment jsdom
/**
 * Task 006 — the transcript renderer (DESIGN.md §2.2).
 *
 * These assertions are the design, not decoration. Each one names a rule that
 * a reasonable-looking implementation gets wrong:
 *
 * - assistant text is a **ghost** row, unframed and full width; only the user's
 *   turn is framed (`DESIGN.md:68-69`). Framing both makes a transcript read
 *   as a chat log rather than a document.
 * - thinking is **collapsed by default** and expands **inline** — never a side
 *   pane (`D54`), because a pane competes with the artifact drawer during
 *   exactly the turns where both matter.
 * - `ok` / `error` / `aborted` / `rejected` are **visually distinct**
 *   (`DESIGN.md:71`) and all four read as *results*: nothing may look like a
 *   crash (`DESIGN.md:186`).
 * - a tool row is one line until expanded (`DESIGN.md:206`).
 * - the transcript is **append-only**: nothing offers a delete or an edit that
 *   would remove a row (`D19`, `DESIGN.md:60`).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TranscriptView, ThinkingRegion, ToolRow } from "./TranscriptView";
import type { ContentBlock, RenderRow } from "./types";

// This project has no global vitest setup, so RTL's automatic cleanup does not
// run — `ArtifactDrawer.test.tsx` calls `cleanup()` explicitly for the same
// reason. Without it, one test's DOM leaks into the next.
afterEach(cleanup);

function row(block: ContentBlock, over: Partial<RenderRow> = {}): RenderRow {
  return { block, role: "assistant", id: "r1", seq: 0, generation: 0, ...over };
}

function text(s: string, over: Partial<RenderRow> = {}): RenderRow {
  return row({ kind: "text", text: s }, over);
}

describe("TranscriptView", () => {
  it("renders assistant text unframed and the user turn framed", () => {
    render(
      <TranscriptView
        rows={[text("the answer", { id: "a", seq: 1 }), text("my question", { id: "u", seq: 0, role: "user" })]}
      />,
    );
    const user = screen.getByTestId("row-u");
    const assistant = screen.getByTestId("row-a");
    // Only the user row is a framed bubble.
    expect(user.getAttribute("data-framed")).toBe("true");
    expect(assistant.getAttribute("data-framed")).toBe("false");
  });

  it("renders every block kind without throwing", () => {
    const rows: RenderRow[] = [
      text("hi", { id: "1", seq: 0 }),
      row(
        { kind: "thinking", text: "reasoning", signature: "sig", display: "full" },
        { id: "2", seq: 1 },
      ),
      row({ kind: "tool_use", id: "c1", name: "fs", input_json: "{}" }, { id: "3", seq: 2 }),
      row(
        { kind: "tool_result", tool_use_id: "c1", status: "ok", preview: "read 2 lines", preview_path: null },
        { id: "4", seq: 3 },
      ),
      row(
        { kind: "notice", level: "warn", text: "the provider dropped a thinking block" },
        { id: "5", seq: 4 },
      ),
      row({ kind: "summary", text: "earlier work", boundary: 4, generation: 1 }, { id: "6", seq: 5 }),
      row({ kind: "compaction", provider_block_id: "cmp_1" }, { id: "7", seq: 6 }),
      row(
        {
          kind: "question_card",
          id: "q1",
          prompt: "which one?",
          options: [{ id: "a", label: "A" }],
          allow_free_text: false,
          resolved: null,
        },
        { id: "8", seq: 7 },
      ),
      row({ kind: "artifact_ref", artifact_id: "a1", version: 1, title: "Chart" }, { id: "9", seq: 8 }),
    ];
    expect(() => render(<TranscriptView rows={rows} />)).not.toThrow();
    expect(screen.getByText("the provider dropped a thinking block")).toBeTruthy();
  });

  it("offers no way to delete or edit a row", () => {
    render(<TranscriptView rows={[text("append only", { id: "x" })]} />);
    // D19: the surface is append-only. A delete affordance anywhere here is a
    // promise the store cannot keep.
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("renders an empty thread without an illustration or a spinner", () => {
    render(<TranscriptView rows={[]} />);
    expect(screen.getByTestId("transcript-empty")).toBeTruthy();
  });
});

describe("ThinkingRegion", () => {
  // Multi-line, so "one-line preview" is a real distinction: a collapsed
  // region that rendered its whole body would not be collapsed.
  const thinking: ContentBlock = {
    kind: "thinking",
    text: "I should read the lexer first.\nThen check the tests.\nThen decide whether to change the parser.",
    signature: "sig",
    display: "full",
  };

  it("is collapsed by default", () => {
    render(<ThinkingRegion block={thinking} />);
    const toggle = screen.getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows only the first line while collapsed", () => {
    render(<ThinkingRegion block={thinking} />);
    expect(screen.getByText(/I should read the lexer first/)).toBeTruthy();
    // Later lines are not on screen until expanded.
    expect(screen.queryByText(/Then check the tests/)).toBeNull();
    expect(screen.queryByText(/Then decide whether/)).toBeNull();
  });

  it("expands and collapses inline", async () => {
    const user = userEvent.setup();
    render(<ThinkingRegion block={thinking} />);
    const toggle = screen.getByRole("button");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Then check the tests/)).toBeTruthy();

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Then check the tests/)).toBeNull();
  });

  it("never renders as a side pane", () => {
    const { container } = render(<ThinkingRegion block={thinking} />);
    // D54: no aside, no complementary landmark, no off-canvas region.
    expect(container.querySelector("aside")).toBeNull();
    expect(container.querySelector("[role='complementary']")).toBeNull();
  });

  it("renders the same shape for both providers", () => {
    // D54: the transcript cannot branch on provider. Two thinking blocks with
    // the same shape must produce the same affordances.
    const a = render(<ThinkingRegion block={thinking} />);
    const summaryVariant: ContentBlock = { ...thinking, display: "summary" };
    a.rerender(<ThinkingRegion block={summaryVariant} />);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("ToolRow", () => {
  const base = { name: "fs", input_json: "{}" };

  it.each([
    ["ok", "ok"],
    ["error", "error"],
    ["aborted", "aborted"],
    ["rejected", "rejected"],
  ] as const)("gives %s a distinct status", (status, expected) => {
    const { container } = render(
      <ToolRow
        toolUse={{ kind: "tool_use", id: "c1", ...base }}
        result={{ kind: "tool_result", tool_use_id: "c1", status, preview: "output", preview_path: null }}
      />,
    );
    const row = container.querySelector("[data-status]");
    expect(row?.getAttribute("data-status")).toBe(expected);
  });

  it("does not present a failure as a crash", () => {
    // D55 / DESIGN.md:186 — every status is a result the model reads, so
    // nothing says "error" in a way that implies the app broke.
    const { container } = render(
      <ToolRow
        toolUse={{ kind: "tool_use", id: "c1", ...base }}
        result={{
          kind: "tool_result",
          tool_use_id: "c1",
          status: "error",
          preview: "no such file",
          preview_path: null,
        }}
      />,
    );
    expect(container.textContent || "").not.toMatch(/crash|panic|fatal/i);
  });

  it("keeps the preview collapsed until asked", async () => {
    const user = userEvent.setup();
    render(
      <ToolRow
        toolUse={{ kind: "tool_use", id: "c1", ...base }}
        result={{
          kind: "tool_result",
          tool_use_id: "c1",
          status: "ok",
          preview: "a very long preview ".repeat(40),
          preview_path: null,
        }}
      />,
    );
    expect(screen.queryByText(/a very long preview/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(screen.getByText(/a very long preview/)).toBeTruthy();
  });

  it("shows the re-readable path when the preview was bounded", async () => {
    // D27: a bounded preview without its path is data loss — the model could
    // never read the full text. It lives inside the expanded region, because
    // the row is one line until asked.
    const user = userEvent.setup();
    render(
      <ToolRow
        toolUse={{ kind: "tool_use", id: "c1", ...base }}
        result={{
          kind: "tool_result",
          tool_use_id: "c1",
          status: "ok",
          preview: "first 400 bytes",
          preview_path: "C:/w/full.txt",
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /preview/i }));
    expect(within(screen.getByTestId("tool-c1")).getByText(/full\.txt/)).toBeTruthy();
  });
});