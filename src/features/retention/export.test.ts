import { describe, expect, it } from "vitest";
import { exportFilename } from "./export";

describe("exportFilename (review 31: files used to be named thread-<id>)", () => {
  it("uses the sanitised title when present", () => {
    expect(exportFilename("Debounce in React", "t1", "md")).toBe("Debounce in React.md");
  });

  it("strips path- and shell-hostile characters", () => {
    expect(exportFilename('Q3: roadmap/plan? "final"|v2', "t1", "html")).toBe(
      "Q3 roadmapplan finalv2.html",
    );
  });

  it("falls back to the thread id when the title is empty or only junk", () => {
    expect(exportFilename("", "t1", "md")).toBe("thread-t1.md");
    expect(exportFilename("   ", "t1", "md")).toBe("thread-t1.md");
    expect(exportFilename("///", "t1", "md")).toBe("thread-t1.md");
  });

  it("caps runaway titles so the download name stays usable", () => {
    const name = exportFilename("x".repeat(300), "t1", "md");
    expect(name.length).toBeLessThanOrEqual(83); // 80 + "." + "md"
    expect(name.endsWith(".md")).toBe(true);
  });
});
