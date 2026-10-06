// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeleteConfirm } from "./DeleteConfirm";

describe("DeleteConfirm", () => {
  it("names what will be destroyed", () => {
    render(<DeleteConfirm target="project Alpha" onConfirm={() => {}} />);
    expect(screen.getAllByText(/project alpha/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /delete/i })).toBeDefined();
  });
});
