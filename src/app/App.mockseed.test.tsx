// Mock-seed rail mapping (Task: mock rail mirrors the html truth).
// Pure helper only — mock MODE itself cannot run under vitest (mode "test"),
// so these tests pin the seed → rail mapping `seedToRail` owns.
import { describe, expect, it } from "vitest";
import { mockDetailProps, parseSeedSize, seedToRail } from "./App";

const CHATS = [
  { id: "c1", title: "Debounce in React", pinned: true, projectId: null, updated: "2026-10-08T09:10:00" },
  { id: "c2", title: "API design notes", pinned: true, projectId: "pr2", updated: "2026-10-05T10:00:00" },
  { id: "c3", title: "Draft email to client", pinned: false, projectId: "pr2", updated: "2026-10-08T08:00:00" },
  { id: "c4", title: "Tailwind vs plain CSS", pinned: false, projectId: null, updated: "2026-10-07T16:20:00" },
] as const;

const PROJECTS = [
  { id: "pr1", name: "Portfolio site", desc: "Personal developer portfolio", updated: "2026-10-06", instructions: "Answer as a senior frontend engineer.", files: [{ name: "brief.pdf", size: "210 KB" }] },
  { id: "pr2", name: "Client dashboard", desc: "Analytics dashboard for a freelance client", updated: "2026-10-03" },
] as const;

describe("seedToRail", () => {
  it("maps every seed chat to a flat rail row with title, pin and project intact", () => {
    const { chats } = seedToRail([...CHATS], [...PROJECTS]);
    expect(chats).toHaveLength(4);
    expect(chats).toContainEqual(
      expect.objectContaining({ id: "c1", title: "Debounce in React", pinned: true, projectId: null }),
    );
    expect(chats).toContainEqual(
      expect.objectContaining({ id: "c2", title: "API design notes", pinned: true, projectId: "pr2" }),
    );
  });

  it("keeps the rail row timestamp parseable to the seed instant", () => {
    const { chats } = seedToRail([...CHATS], [...PROJECTS]);
    for (const row of chats) {
      const seed = CHATS.find((c) => c.id === row.id);
      expect(Date.parse(String(row.updated))).toBe(Date.parse(seed?.updated ?? ""));
    }
  });

  it("maps seed projects to id+name+desc without inventing fields", () => {
    const { projects } = seedToRail([...CHATS], [...PROJECTS]);
    expect(projects).toContainEqual(
      expect.objectContaining({ id: "pr1", name: "Portfolio site", desc: "Personal developer portfolio" }),
    );
    expect(projects).toHaveLength(2);
  });

  it("nests only project-owned chats under threadsByProject; flat rows cover the rest", () => {
    const { threadsByProject } = seedToRail([...CHATS], [...PROJECTS]);
    expect((threadsByProject["pr2"] ?? []).map((t) => t.id).sort()).toEqual(["c2", "c3"]);
    expect(threadsByProject["pr1"] ?? []).toEqual([]);
    // Unprojected chats (c1, c4) must not appear nested anywhere.
    const nested = Object.values(threadsByProject).flat().map((t) => t.id);
    expect(nested).not.toContain("c1");
    expect(nested).not.toContain("c4");
  });

  it("emits one store update stamp per chat at the seed instant", () => {
    const { updates } = seedToRail([...CHATS], [...PROJECTS]);
    expect(updates).toHaveLength(4);
    for (const u of updates) {
      const seed = CHATS.find((c) => c.id === u.id);
      expect(u.updatedAt).toBe(Date.parse(seed?.updated ?? ""));
    }
  });

  it("counts chats per project for the grid cards", () => {
    const { chatCountByProject } = seedToRail([...CHATS], [...PROJECTS]);
    expect(chatCountByProject).toEqual({ pr1: 0, pr2: 2 });
  });

  it("carries detail content per project: instructions + files with honest byte sizes", () => {
    const { meta } = seedToRail([...CHATS], [...PROJECTS]);
    expect(meta["pr1"]).toEqual({
      instructions: "Answer as a senior frontend engineer.",
      files: [{ name: "brief.pdf", sizeBytes: 215040 }],
    });
    expect(meta["pr2"]).toEqual({ instructions: "", files: [] });
  });

  it("parses seed file sizes honestly, unknown units resolve to 0", () => {
    expect(parseSeedSize("210 KB")).toBe(215040);
    expect(parseSeedSize("1.2 MB")).toBe(1258291);
    expect(parseSeedSize("12 B")).toBe(12);
    expect(parseSeedSize("nonsense")).toBe(0);
  });

  it("mockDetailProps yields honest empties on the real (null-rail) path", () => {
    expect(mockDetailProps(null, "pr1")).toEqual({ instructions: "", chats: [], files: [] });
  });

  it("mockDetailProps yields instructions, owned chats and files on the seed path", () => {
    const rail = seedToRail([...CHATS], [...PROJECTS]);
    expect(mockDetailProps(rail, "pr1")).toEqual({
      instructions: "Answer as a senior frontend engineer.",
      chats: [],
      files: [{ name: "brief.pdf", sizeBytes: 215040 }],
    });
    expect(mockDetailProps(rail, "pr2").chats.map((c) => c.id).sort()).toEqual(["c2", "c3"]);
    expect(mockDetailProps(rail, "nope")).toEqual({ instructions: "", chats: [], files: [] });
  });
});
