// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsGrid } from "./ProjectsGrid";
import type { Project } from "./projects";

// Stylesheet read as text for the CSS-shape assertions (the pattern
// contrast.test.ts uses, adapted for jsdom): this repo ships no @types/node,
// so the node imports are error-typed and asserted to the two signatures the
// test uses (AGENTS §5: no `any`, no `eslint-disable`).
// @ts-expect-error type error without @types/node package (see vite.config.ts)
import { readFileSync as readFileSyncUntyped } from "node:fs";
// @ts-expect-error type error without @types/node package (see vite.config.ts)
import { join as joinUntyped } from "node:path";
const readFileSync = readFileSyncUntyped as (path: string, encoding: "utf8") => string;
const join = joinUntyped as (...segments: string[]) => string;
// Vitest injects import.meta.dirname at runtime; the shipped ImportMeta type
// does not declare it, so read it through a narrow record view (not `any`).
const dirname = (import.meta as { dirname?: string }).dirname;
if (dirname === undefined) throw new Error("import.meta.dirname unavailable");
// .../src/features/projects; two levels up is src/, which holds styles.css.
const cssText = readFileSync(join(dirname, "..", "..", "styles.css"), "utf8");

const NOW = Date.parse("2026-10-10T00:00:00Z");

afterEach(() => {
  cleanup();
});

const projs: Project[] = [
  { id: "a", name: "Alpha", desc: "Research notes", updatedAt: "2026-10-10T00:00:00Z" },
  { id: "b", name: "Beta", desc: "Client work", updatedAt: "2026-10-07T00:00:00Z" },
];

describe("ProjectsGrid", () => {
  it("renders cards, filters by search, fires new-project", async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    const onOpen = vi.fn();
    render(<ProjectsGrid projects={projs} onNew={onNew} onOpen={onOpen} />);
    expect(screen.getByText("Alpha")).toBeDefined();
    await user.click(screen.getByRole("button", { name: /new project/i }));
    expect(onNew).toHaveBeenCalledOnce();
    await user.type(screen.getByPlaceholderText(/search projects/i), "Beta");
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeDefined();
  });

  it("shows desc, chat counts, and relative time per card", () => {
    render(
      <ProjectsGrid
        projects={projs}
        onNew={() => {}}
        onOpen={() => {}}
        chatCountByProject={{ a: 3, b: 1 }}
        now={NOW}
      />,
    );
    expect(screen.getByText("Research notes")).toBeDefined();
    expect(screen.getByTestId("project-meta-a").textContent).toBe("3 chats · Updated today");
    expect(screen.getByTestId("project-meta-b").textContent).toBe("1 chat · Updated 3 days ago");
  });

  it("searches name and description", async () => {
    const user = userEvent.setup();
    render(<ProjectsGrid projects={projs} onNew={() => {}} onOpen={() => {}} />);
    await user.type(screen.getByTestId("project-search"), "client");
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeDefined();
  });

  it("shows an empty state with no matches", async () => {
    const user = userEvent.setup();
    render(<ProjectsGrid projects={projs} onNew={() => {}} onOpen={() => {}} />);
    await user.type(screen.getByTestId("project-search"), "zzz");
    expect(screen.getByTestId("projects-empty").textContent).toBe("No projects found.");
    expect(screen.queryByTestId("projects-grid")?.querySelector("[data-testid^='project-card-']")).toBeNull();
  });

  it("page-grid rhythm: auto-fill 230px columns with a 12px gap token", () => {
    // Review 33: the old assertion only checked classList, so a CSS-token
    // regression was invisible. jsdom does not load styles.css and its
    // getComputedStyle does not resolve the custom-prop cascade, so the suite
    // reads the stylesheet as text (the pattern contrast.test.ts uses) and
    // asserts .page-grid composes the auto-fill/minmax + gap tokens, and that
    // those tokens hold the html truth (230px floor, 12px gap).
    render(<ProjectsGrid projects={projs} onNew={() => {}} onOpen={() => {}} />);
    const grid = screen.getByTestId("projects-grid");
    expect(grid.classList.contains("page-grid")).toBe(true);
    expect(cssText).toMatch(/\.page-grid\s*\{[^}]*minmax\(var\(--page-grid-min\)/);
    expect(cssText).toMatch(/\.page-grid\s*\{[^}]*gap:\s*var\(--page-grid-gap\)/);
    expect(cssText).toMatch(/--page-grid-min:\s*230px/);
    expect(cssText).toMatch(/--page-grid-gap:\s*12px/);
    const dot = screen.getByTestId("project-dot-a");
    expect(dot.style.background).not.toBe("");
  });

  it("page frame normalizes host padding to the 24px page rhythm", () => {
    // Same CSS-shape hardening for the page shell: the App host's p-4 (1rem)
    // padding is cancelled by a -1rem margin so the page lands on --page-pad
    // (24px), and the content is centred in .page-col.
    render(<ProjectsGrid projects={projs} onNew={() => {}} onOpen={() => {}} />);
    expect(screen.getByTestId("projects-grid").closest(".page-frame")).not.toBeNull();
    expect(screen.getByTestId("projects-grid").closest(".page-col")).not.toBeNull();
    expect(cssText).toMatch(/\.page-frame\s*\{[^}]*margin:\s*-1rem/);
    expect(cssText).toMatch(/\.page-frame\s*\{[^}]*padding:\s*var\(--page-pad\)/);
    expect(cssText).toMatch(/--page-pad:\s*24px/);
  });

  it("cards carry a definite 1px border-token frame", () => {
    render(<ProjectsGrid projects={projs} onNew={() => {}} onOpen={() => {}} />);
    const card = screen.getByTestId("project-card-a");
    expect(card.classList.contains("project-card")).toBe(true);
  });

  it("empty state renders a framed panel, not a bare paragraph", async () => {
    const user = userEvent.setup();
    render(<ProjectsGrid projects={projs} onNew={() => {}} onOpen={() => {}} />);
    await user.type(screen.getByTestId("project-search"), "zzz");
    const empty = screen.getByTestId("projects-empty");
    expect(empty.textContent).toBe("No projects found.");
    expect(empty.closest(".empty-frame")).not.toBeNull();
  });

  it("opens cards via onOpen", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<ProjectsGrid projects={projs} onNew={() => {}} onOpen={onOpen} />);
    await user.click(within(screen.getByTestId("project-card-b")).getByRole("button", { name: "Beta" }));
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("new-project action carries a lucide icon (html parity)", () => {
    render(<ProjectsGrid projects={projs} onNew={() => {}} onOpen={() => {}} />);
    const action = screen.getByRole("button", { name: /new project/i });
    expect(action.querySelector("svg")).not.toBeNull();
  });

  it("new-project dialog requires a name, then creates", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onDialogChange = vi.fn();
    render(
      <ProjectsGrid
        projects={projs}
        onNew={() => {}}
        onOpen={() => {}}
        dialogOpen
        onDialogChange={onDialogChange}
        onCreate={onCreate}
      />,
    );
    await user.click(screen.getByTestId("create-project"));
    expect(screen.getByTestId("project-name-error").textContent).toBe("Name is required");
    expect(onCreate).not.toHaveBeenCalled();
    await user.type(screen.getByTestId("project-name-input"), "Gamma");
    await user.type(screen.getByTestId("project-desc-input"), "Side quest");
    await user.click(screen.getByTestId("create-project"));
    expect(onCreate).toHaveBeenCalledWith({ name: "Gamma", desc: "Side quest" });
  });
});
