//! Task 019 batch 2 — incognito, fork, export builders.
import { describe, expect, it } from "vitest";
import {
  excludeIncognito,
  forkPrefix,
  memoryToJson,
  threadToHtml,
  threadToMarkdown,
} from "./retention";
import { canExportThread, canForkThread } from "./retention";

describe("019 batch2", () => {
  it("incognito excluded from history/search/memory", () => {
    const threads = [
      { id: "a", incognito: false },
      { id: "b", incognito: true },
    ];
    expect(excludeIncognito(threads).map((t) => t.id)).toEqual(["a"]);
  });
  it("fork copies prefix under new ids, source untouched", () => {
    const rows = [
      { id: "m1", seq: 1 },
      { id: "m2", seq: 2 },
    ];
    const forked = forkPrefix(rows, (old) => `new-${old}`);
    expect(forked.map((r) => r.id)).toEqual(["new-m1", "new-m2"]);
    expect(rows[0].id).toBe("m1");
  });
  it("thread export html self-contained, markdown readable", () => {
    const blocks = [{ kind: "text", text: "hi" }];
    const html = threadToHtml("T", blocks);
    expect(html).toContain("<html>");
    expect(html).toContain("hi");
    expect(threadToMarkdown("T", blocks)).toContain("hi");
  });
  it("memory export json round-trips", () => {
    const mem = [{ topic: "t", body: "b" }];
    expect(JSON.parse(memoryToJson(mem))).toEqual(mem);
  });
  it("incognito unexportable + unforkable from UI", () => {
    expect(canExportThread(true)).toBe(false);
    expect(canForkThread(true)).toBe(false);
    expect(canExportThread(false)).toBe(true);
    expect(canForkThread(false)).toBe(true);
  });
});
