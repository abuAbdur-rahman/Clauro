//! Task 018 failing tests first — project scoping pure logic.
import { describe, expect, it } from "vitest";
import {
  attachmentKey,
  memoryVisibleTo,
  renameProject,
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
});
