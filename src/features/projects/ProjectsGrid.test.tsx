// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsGrid } from "./ProjectsGrid";
import type { Project } from "../projects/projects";

const projs: Project[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
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
});
