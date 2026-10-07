//! Task 018 failing tests first — project scoping pure logic.
import { describe, expect, it } from "vitest";
import {
  attachmentKey,
  memoryVisibleTo,
  renameProject,
  describeControl,
  frozenSystem,
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
