//! Task 018 rail test first.
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectsRail } from "./ProjectsRail";

describe("ProjectsRail", () => {
  it("shows crossed-out icon when memory off, nothing when on", () => {
    window.matchMedia = ((_q: string) =>
      ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const { rerender } = render(
      <ProjectsRail projects={[]} memoryOff={true} />,
    );
    expect(screen.getByLabelText(/memory off/i)).toBeDefined();
    rerender(<ProjectsRail projects={[]} memoryOff={false} />);
    expect(screen.queryByLabelText(/memory off/i)).toBeNull();
  });
});
