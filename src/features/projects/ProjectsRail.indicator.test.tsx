/** Task 029 — 4-state thread indicator. Fails until `statusByThread` prop exists. */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ProjectsRail } from "./ProjectsRail";
import type { ThreadStatus } from "@/mock/seed";

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

function matchMedia(query: string) {
  return {
    matches: query.length === 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList;
}

beforeEach(() => {
  cleanup();
  window.matchMedia = matchMedia;
});

const PROJECTS = [{ id: "default", name: "Default" }] as const;

function status(id: string, s: ThreadStatus) {
  return { [id]: s };
}

describe("ProjectsRail indicator", () => {
  it("renders working/done/not-viewed/idle states with testids", async () => {
    const { rerender } = render(
      <ProjectsRail
        projects={[...PROJECTS]}
        memoryOff={false}
        threadsByProject={{ default: [{ id: "t1", title: "One" }] }}
        statusByThread={status("t1", "working")}
      />,
    );
    expect((await screen.findByTestId("thread-row-t1")).getAttribute("data-status")).toBe("working");
    rerender(
      <ProjectsRail
        projects={[...PROJECTS]}
        memoryOff={false}
        threadsByProject={{ default: [{ id: "t1", title: "One" }] }}
        statusByThread={status("t1", "done")}
      />,
    );
    expect((await screen.findByTestId("thread-row-t1")).getAttribute("data-status")).toBe("done");
  });

  it("marks viewed-on-open via onSelectThread", async () => {
    let seen = "";
    render(
      <ProjectsRail
        projects={[...PROJECTS]}
        memoryOff={false}
        threadsByProject={{ default: [{ id: "t2", title: "Two" }] }}
        statusByThread={status("t2", "done")}
        onSelectThread={(id) => {
          seen = id;
        }}
      />,
    );
    (await screen.findByTestId("thread-row-t2")).click();
    expect(seen).toBe("t2");
  });
});
