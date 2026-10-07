// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette";

describe("CommandPalette search + tabs + recents", () => {
  it("filters recents by query and tab, shows hints footer", async () => {
    const user = userEvent.setup();
    const recents = [
      { id: "r1", tab: "chats" as const, label: "Review tokenizer" },
      { id: "r2", tab: "projects" as const, label: "Alpha" },
    ];
    render(
      <CommandPalette
        state={{ turnRunning: false }}
        open={true}
        recents={recents}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Review tokenizer")).toBeDefined();
    await user.click(screen.getByRole("tab", { name: /projects/i }));
    expect(screen.queryByText("Review tokenizer")).toBeNull();
    expect(screen.getByText("Alpha")).toBeDefined();
    await user.click(screen.getByRole("tab", { name: /^all$/i }));
    await user.type(screen.getByPlaceholderText(/search/i), "token");
    expect(screen.getByText("Review tokenizer")).toBeDefined();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText(/esc/i)).toBeDefined();
  });
});
