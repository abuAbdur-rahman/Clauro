//! Task 018 rail test first.
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectsRail } from "./ProjectsRail";

describe("ProjectsRail", () => {
  it("shows crossed-out icon when memory off, nothing when on", () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query.length === 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList;
    const { rerender } = render(
      <ProjectsRail projects={[]} memoryOff={true} />,
    );
    expect(screen.getByLabelText(/memory off/i)).toBeDefined();
    rerender(<ProjectsRail projects={[]} memoryOff={false} />);
    expect(screen.queryByLabelText(/memory off/i)).toBeNull();
  });
  it("nests child threads under their project", () => {
    render(
      <ProjectsRail
        projects={[{ id: "p1", name: "Alpha" }]}
        memoryOff={false}
        threadsByProject={{ p1: [{ id: "t1", title: "Milestones" }] }}
      />,
    );
    expect(screen.getByText("Milestones")).toBeDefined();
  });
});
