// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ModelPicker from "./ModelPicker";
import { useThreadStore } from "../features/catalogue/thread";
import type { CataloguePayload } from "../features/catalogue/catalogue";

/**
 * Model picker on shadcn Select (Task 025, D112).
 * One trigger, provider-grouped options with limits; choosing writes
 * thread-level state only. Unknown selections degrade to a notice.
 */

// Radix Select needs these in jsdom.
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {};
window.HTMLElement.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
  return false;
};
window.HTMLElement.prototype.setPointerCapture = function setPointerCapture(): void {};
window.HTMLElement.prototype.releasePointerCapture = function releasePointerCapture(): void {};

const THREAD = "picker-t1";

function livePayload(): CataloguePayload {
  return {
    state: "live",
    models: 2,
    catalogue: {
      providers: {
        anthropic: [
          {
            id: "claude-haiku-4-5",
            name: "Haiku",
            context_window: 200000,
            max_output: 8192,
            reasoning: false,
            tool_call: true,
          },
        ],
        local: [
          {
            id: "tiny-8k",
            name: "Tiny",
            context_window: 8192,
            max_output: 2048,
            reasoning: false,
            tool_call: false,
          },
        ],
      },
    },
  };
}

beforeEach(() => {
  cleanup();
  useThreadStore.getState().reset();
  useThreadStore.getState().openThread(THREAD);
});

describe("ModelPicker on Select", () => {
  it("renders a select trigger with a placeholder when no model is chosen", () => {
    render(<ModelPicker payload={livePayload()} threadId={THREAD} />);
    expect(screen.getByRole("combobox").textContent).toMatch(/choose a model/i);
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("opens provider-grouped options carrying limits", async () => {
    const user = userEvent.setup();
    render(<ModelPicker payload={livePayload()} threadId={THREAD} />);
    await user.click(screen.getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    const groups = within(listbox).getAllByRole("group");
    expect(groups).toHaveLength(2);
    expect(within(listbox).getByRole("option", { name: /haiku/i })).not.toBeNull();
    // Limits travel with the option, so the choice is informed.
    expect(within(listbox).getByText(/200k ctx/i)).not.toBeNull();
  });

  it("choosing an option writes thread-level state and the thread stays open", async () => {
    const user = userEvent.setup();
    render(<ModelPicker payload={livePayload()} threadId={THREAD} />);
    await user.click(screen.getByRole("combobox"));
    const option = await screen.findByRole("option", { name: /haiku/i });
    await user.click(option);
    const thread = useThreadStore.getState().threads[THREAD];
    expect(thread?.open).toBe(true);
    expect(thread?.model?.provider).toBe("anthropic");
    expect(thread?.model?.id).toBe("claude-haiku-4-5");
    expect(screen.getByRole("combobox").textContent).toMatch(/haiku/i);
  });

  it("offline catalogue renders the honest-empty notice, not a crash", () => {
    render(<ModelPicker payload={{ state: "absent" }} threadId={THREAD} />);
    expect(screen.getByText(/offline/i)).not.toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("stale catalogue renders the refreshing state", () => {
    render(<ModelPicker payload={{ state: "stale", models: 3 }} threadId={THREAD} />);
    expect(screen.getByText(/refreshing/i)).not.toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
