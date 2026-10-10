//! Task 018 failing tests first — project scoping pure logic.
import { describe, expect, it } from "vitest";
import {
  attachmentKey,
  memoryVisibleTo,
  renameProject,
  describeControl,
  frozenSystem,
  projectColor,
  projectDotColor,
  projectDescription,
  formatProjectUpdated,
  formatChatCount,
  formatFileSize,
  knowledgeUsage,
  PROJECT_COLORS,
} from "./projects";

describe("018 projects scoping", () => {
  it("memory invisible both directions", () => {
    const a = [{ projectId: "A", topic: "x" }];
    expect(memoryVisibleTo(a, "B")).toEqual([]);
    const b = [{ projectId: "B", topic: "y" }];
    expect(memoryVisibleTo(b, "A")).toEqual([]);
  });
  it("rename moves no files, id authoritative", () => {
    const p = renameProject({ id: "opaque-1", name: "old" }, "new");
    expect(p.id).toBe("opaque-1");
    expect(p.name).toBe("new");
  });
  it("dedupe per project never global", () => {
    expect(attachmentKey("A", "hash1")).not.toBe(attachmentKey("B", "hash1"));
    expect(attachmentKey("A", "hash1")).toBe(attachmentKey("A", "hash1"));
  });
  it("four controls distinct", () => {
    const controls = ["account-pause", "account-reset", "thread-off", "sensitive"] as const;
    const descs = controls.map((c) => describeControl(c));
    expect(new Set(descs).size).toBe(4);
  });
  it("instructions join frozen system", () => {
    expect(frozenSystem("be terse", "base")).toContain("be terse");
    expect(frozenSystem("", "base")).toBe("base");
  });
});

describe("project card helpers", () => {
  it("projectColor is deterministic and never index-based", () => {
    expect(projectColor("alpha")).toBe(projectColor("alpha"));
    expect(PROJECT_COLORS).toContain(projectColor("alpha"));
    // Reordering the list cannot change a dot: color derives from the id hash.
    expect(projectColor("alpha")).not.toBe("");
  });
  it("explicit color wins over the hash fallback", () => {
    expect(projectDotColor({ id: "a", name: "A", color: "#123456" })).toBe("#123456");
    expect(projectDotColor({ id: "a", name: "A" })).toBe(projectColor("a"));
  });
  it("reads desc or description, empty otherwise", () => {
    expect(projectDescription({ id: "a", name: "A", desc: "d" })).toBe("d");
    expect(projectDescription({ id: "a", name: "A", description: "e" })).toBe("e");
    expect(projectDescription({ id: "a", name: "A" })).toBe("");
  });
  it("formats relative updated time, null when unknown", () => {
    const now = Date.parse("2026-10-10T00:00:00Z");
    expect(formatProjectUpdated(undefined, now)).toBeNull();
    expect(formatProjectUpdated("", now)).toBeNull();
    expect(formatProjectUpdated("not-a-date", now)).toBeNull();
    expect(formatProjectUpdated("2026-10-10T00:00:00Z", now)).toBe("Updated today");
    expect(formatProjectUpdated("2026-10-09T00:00:00Z", now)).toBe("Updated 1 day ago");
    expect(formatProjectUpdated("2026-10-07T00:00:00Z", now)).toBe("Updated 3 days ago");
  });
  it("formats chat counts", () => {
    expect(formatChatCount(0)).toBe("0 chats");
    expect(formatChatCount(1)).toBe("1 chat");
    expect(formatChatCount(5)).toBe("5 chats");
  });
  it("formats real file sizes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
  it("capacity derives from real sizes, never a constant", () => {
    const files = [
      { name: "a.pdf", sizeBytes: 1024 },
      { name: "b.pdf", sizeBytes: 3072 },
    ];
    const usage = knowledgeUsage(files, 8192);
    expect(usage.usedBytes).toBe(4096);
    expect(usage.percent).toBe(50);
    expect(usage.label).toBe("50% of project knowledge used");
    expect(knowledgeUsage([], 8192).percent).toBe(0);
  });
});
