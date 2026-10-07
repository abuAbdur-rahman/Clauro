// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectDetail } from "./ProjectDetail";

describe("ProjectDetail", () => {
  it("shows breadcrumb, instructions/memory/context panels", () => {
    render(
      <ProjectDetail
        project={{ id: "p1", name: "Alpha" }}
        instructions="Be terse"
        memoryCount={3}
        contextUsed="12%"
        onBack={() => {}}
      />,
    );
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getByText(/instructions/i)).toBeDefined();
    expect(screen.getByText(/memory/i)).toBeDefined();
    expect(screen.getByText(/context/i)).toBeDefined();
    expect(screen.getByText("12%")).toBeDefined();
  });
});
