//! Task 018 rail on shadcn primitives (UI-GUIDE §6).
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { ProjectsRail, groupRailChats, projectColor } from "./ProjectsRail";

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
  // Sidebar collapse persists via localStorage (B04) — isolate tests.
  window.localStorage.clear();
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

  it("groups threads under date headers instead of a Recent bucket", () => {
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
    // Threads without timestamps group as TODAY (Task 029 sidebar parity).
    expect(screen.getByTestId("chat-group-TODAY")).toBeDefined();
    expect(screen.queryByText("Recent")).toBeNull();
  });

  it("collapse toggle narrows the rail", async () => {
    const user = userEvent.setup();
    render(<ProjectsRail projects={[{ id: "p1", name: "Alpha" }]} memoryOff={false} />);
    const rail = screen.getByTestId("projects-rail");
    expect(rail.className).toContain("w-[260px]");
    await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));
    expect(rail.className).toContain("w-14");
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

// Task 029 sidebar parity: date groups, row menu, rename, footer.
const NOW = Date.parse("2026-10-08T12:00:00");

const GROUP_CHATS = [
  { id: "c1", title: "Pinned old", pinned: true, projectId: null, updated: "2026-10-05T10:00:00" },
  { id: "c2", title: "Today thread", projectId: "p1", updated: "2026-10-08T09:10:00" },
  { id: "c3", title: "Yesterday thread", projectId: null, updated: "2026-10-07T16:20:00" },
  { id: "c4", title: "Last week thread", projectId: "p2", updated: "2026-10-05T14:00:00" },
  { id: "c5", title: "Ancient thread", projectId: null, updated: "2026-09-18T12:00:00" },
] as const;

const GROUP_PROJECTS = [
  { id: "p1", name: "Portfolio site" },
  { id: "p2", name: "Client dashboard" },
] as const;

function renderGrouped(extra: Record<string, unknown> = {}) {
  return render(
    <ProjectsRail
      projects={[...GROUP_PROJECTS]}
      memoryOff={false}
      chats={[...GROUP_CHATS]}
      now={NOW}
      {...extra}
    />,
  );
}

describe("ProjectsRail date groups", () => {
  it("groupRailChats buckets pinned/today/yesterday/prev-7/older", () => {
    const groups = groupRailChats([...GROUP_CHATS], NOW);
    expect(groups.map(([label]) => label)).toEqual([
      "PINNED",
      "TODAY",
      "YESTERDAY",
      "PREVIOUS 7 DAYS",
      "OLDER",
    ]);
    expect(groups.map(([, rows]) => rows.map((r) => r.id))).toEqual([
      ["c1"],
      ["c2"],
      ["c3"],
      ["c4"],
      ["c5"],
    ]);
  });

  it("groupRailChats omits empty buckets and sorts newest-first", () => {
    const groups = groupRailChats(
      [
        { id: "a", title: "Old", updated: "2026-09-01T00:00:00" },
        { id: "b", title: "New", updated: "2026-10-08T11:00:00" },
      ],
      NOW,
    );
    expect(groups.map(([label]) => label)).toEqual(["TODAY", "OLDER"]);
  });

  it("projectColor follows the prototype wheel by project index", () => {
    expect(projectColor("p1", [...GROUP_PROJECTS])).toBe("#c96442");
    expect(projectColor("p2", [...GROUP_PROJECTS])).toBe("#0067c0");
    expect(projectColor(null, [...GROUP_PROJECTS])).toBeUndefined();
    expect(projectColor("unknown", [...GROUP_PROJECTS])).toBeUndefined();
  });

  it("renders sticky group headers for every non-empty bucket", () => {
    renderGrouped();
    for (const label of ["PINNED", "TODAY", "YESTERDAY", "PREVIOUS 7 DAYS", "OLDER"]) {
      const header = screen.getByTestId(`chat-group-${label}`);
      expect(header.className).toContain("sticky");
    }
    expect(screen.getByTestId("thread-row-c1")).toBeDefined();
    expect(screen.getByTestId("thread-row-c5")).toBeDefined();
  });

  it("rows show the project color dot and the active accent bar", () => {
    renderGrouped({ activeThreadId: "c2" });
    const dot = screen.getByTestId("thread-dot-c2");
    expect(dot.style.backgroundColor).toBe("rgb(201, 100, 66)");
    expect(screen.getByTestId("thread-accent-c2")).toBeDefined();
    // No-project rows carry no dot.
    expect(screen.queryByTestId("thread-dot-c3")).toBeNull();
  });
});

describe("ProjectsRail row menu", () => {
  it("pin / export / delete dispatch per-thread callbacks", async () => {
    const user = userEvent.setup();
    const onPinThread = vi.fn();
    const onExportThread = vi.fn();
    const onDeleteThread = vi.fn();
    renderGrouped({ onPinThread, onExportThread, onDeleteThread });
    await user.click(screen.getByTestId("thread-menu-c2"));
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(onPinThread).toHaveBeenCalledWith("c2", true);

    await user.click(screen.getByTestId("thread-menu-c2"));
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(onExportThread).toHaveBeenCalledWith("c2");

    await user.click(screen.getByTestId("thread-menu-c2"));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDeleteThread).toHaveBeenCalledWith("c2");
  },
  // Interaction-heavy: sequential Radix menu opens exceed the 5s default
  // under full-suite parallel load (passes in isolation in ~2s).
  30000);

  it("pinned rows offer Unpin", async () => {
    const user = userEvent.setup();
    const onPinThread = vi.fn();
    renderGrouped({ onPinThread });
    await user.click(screen.getByTestId("thread-menu-c1"));
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(onPinThread).toHaveBeenCalledWith("c1", false);
  });

  async function openMoveSubmenu(user: UserEvent): Promise<void> {
    // Radix opens the submenu on ArrowRight (hover is flaky under jsdom:
    // all rects are zero-size, so pointer routing is unreliable).
    await user.click(screen.getByTestId("thread-menu-c2"));
    const sub = screen.getByRole("menuitem", { name: "Move to project" });
    sub.focus();
    await user.keyboard("{ArrowRight}");
  }

  it("move-to-project submenu offers No project", async () => {
    const user = userEvent.setup();
    const onMoveThread = vi.fn();
    renderGrouped({ onMoveThread });
    await openMoveSubmenu(user);
    // Radix sub-items need a raw click event under jsdom (pointer-up
    // select does not fire through user-event here).
    fireEvent.click(screen.getByRole("menuitem", { name: "No project" }));
    expect(onMoveThread).toHaveBeenCalledWith("c2", null);
  });

  it("move-to-project submenu lists every project", async () => {
    const user = userEvent.setup();
    const onMoveThread = vi.fn();
    renderGrouped({ onMoveThread });
    await openMoveSubmenu(user);
    fireEvent.click(screen.getByRole("menuitem", { name: "Client dashboard" }));
    expect(onMoveThread).toHaveBeenCalledWith("c2", "p2");
  });

  it("rename opens an inline input; Enter saves, Escape cancels", async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn();
    renderGrouped({ onRenameThread });
    await user.click(screen.getByTestId("thread-menu-c2"));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByTestId("rename-input-c2");
    expect(input).toBeDefined();
    await user.clear(input);
    await user.type(input, "Renamed thread");
    await user.keyboard("{Enter}");
    expect(onRenameThread).toHaveBeenCalledWith("c2", "Renamed thread");
    expect(screen.queryByTestId("rename-input-c2")).toBeNull();
  },
  // Interaction-heavy: clear+type keystrokes exceed the 5s default under
  // full-suite parallel load (passes in isolation in ~2s).
  30000);

  it("rename Escape cancels without saving", async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn();
    renderGrouped({ onRenameThread });
    await user.click(screen.getByTestId("thread-menu-c3"));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.keyboard("{Escape}");
    expect(onRenameThread).not.toHaveBeenCalled();
    expect(screen.queryByTestId("rename-input-c3")).toBeNull();
  });
});

describe("ProjectsRail new chat + footer", () => {
  it("new chat is a primary button with a Ctrl+N hint", async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    renderGrouped({ onNewChat });
    expect(screen.getByText("Ctrl+N")).toBeDefined();
    await user.click(screen.getByRole("button", { name: /new chat/i }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("footer shows avatar identity and a profile menu", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    renderGrouped({ onOpenSettings, userName: "Abu", userPlan: "BYOK · Free" });
    // Avatar initials + name + plan (mock-html parity).
    expect(screen.getByText("AB")).toBeDefined();
    expect(screen.getByText("Abu")).toBeDefined();
    expect(screen.getByText("BYOK · Free")).toBeDefined();

    await user.click(screen.getByTestId("profile-menu"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toBeDefined();
    // Unwired entries stay disabled with a reason.
    const shortcuts = within(menu).getByRole("menuitem", { name: "Shortcuts" });
    expect(shortcuts.getAttribute("data-disabled")).not.toBeNull();
    expect(shortcuts.getAttribute("title")).toMatch(/no owner/i);
    await user.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("collapsed footer keeps the avatar icon", async () => {
    const user = userEvent.setup();
    renderGrouped();
    await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));
    const profile = screen.getByTestId("profile-menu");
    expect(profile.getAttribute("aria-label")).toMatch(/Abu/);
    expect(screen.queryByTestId("chat-group-TODAY")).toBeNull();
  });
});
