//! Task 018 rail on shadcn primitives (UI-GUIDE §6).
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsRail } from "./ProjectsRail";

// Radix tooltip/popover positioning needs this in jsdom (same stub as the
// Composer and ModelPicker suites).
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

describe("ProjectsRail", () => {
  it("shows crossed-out icon when memory off, nothing when on", () => {
    const { rerender } = render(<ProjectsRail projects={[]} memoryOff={true} />);
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
    // Twice by design: once nested under the project, once in RECENT.
    expect(screen.getAllByText("Milestones")).toHaveLength(2);
  });

  it("renders nav actions: new chat, search, projects, settings", () => {
    render(<ProjectsRail projects={[]} memoryOff={false} />);
    expect(screen.getByRole("button", { name: /new chat/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /^search$/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /^projects$/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /settings/i })).toBeDefined();
  });

  it("wires nav callbacks without touching selection", async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    const onSearch = vi.fn();
    const onOpenSettings = vi.fn();
    const onSelectProject = vi.fn();
    render(
      <ProjectsRail
        projects={[]}
        memoryOff={false}
        onNewChat={onNewChat}
        onSearch={onSearch}
        onOpenSettings={onOpenSettings}
        onSelectProject={onSelectProject}
      />,
    );
    await user.click(screen.getByRole("button", { name: /new chat/i }));
    await user.click(screen.getByRole("button", { name: /^search$/i }));
    await user.click(screen.getByRole("button", { name: /settings/i }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(onSearch).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onSelectProject).not.toHaveBeenCalled();
  });

  it("marks the active project and thread", () => {
    render(
      <ProjectsRail
        projects={[{ id: "p1", name: "Alpha" }]}
        memoryOff={false}
        threadsByProject={{ p1: [{ id: "t1", title: "Milestones" }] }}
        activeProjectId="p1"
        activeThreadId="t1"
      />,
    );
    const rail = screen.getByTestId("projects-rail");
    // Three active rows by design: the project button plus its thread in the
    // subtree and in RECENT.
    expect(rail.querySelectorAll('[data-active="true"]').length).toBe(3);
  });

  it("lists recent threads across projects", () => {
    render(
      <ProjectsRail
        projects={[
          { id: "p1", name: "Alpha" },
          { id: "p2", name: "Beta" },
        ]}
        memoryOff={false}
        threadsByProject={{
          p1: [{ id: "t1", title: "First" }],
          p2: [{ id: "t2", title: "Second" }],
        }}
      />,
    );
    expect(screen.getByText("Recent")).toBeDefined();
  });

  it("collapse toggle narrows the rail", async () => {
    const user = userEvent.setup();
    render(<ProjectsRail projects={[{ id: "p1", name: "Alpha" }]} memoryOff={false} />);
    const rail = screen.getByTestId("projects-rail");
    expect(rail.className).toContain("w-[260px]");
    await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));
    expect(rail.className).toContain("w-12");
  });

  it("collapsed icon buttons keep accessible names", async () => {
    const user = userEvent.setup();
    render(<ProjectsRail projects={[{ id: "p1", name: "Alpha" }]} memoryOff={false} />);
    await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));
    // Tooltips are hover-only; the name must live on the button itself.
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  });
});
