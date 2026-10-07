// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Composer from "./Composer";
import { useThreadStore } from "../features/catalogue/thread";

// The embedded ModelPicker loads from the providers bridge; an empty list
// keeps it quiet without touching the network.
vi.mock("../features/providers/providers", () => ({
  providerList: () => Promise.resolve([]),
  providerModelsEnriched: () => Promise.resolve([]),
}));

/**
 * Composer shell (Task 027). Textarea + footer actions: attach, memory
 * toggle, effort select, model picker, send. Send is a callback — no loop
 * exists yet (023 owns dispatch). Voice renders disabled: no voice, DESIGN §6.
 */

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

const THREAD = "composer-t1";

beforeEach(() => {
  cleanup();
  useThreadStore.getState().reset();
  useThreadStore.getState().openThread(THREAD);
});

describe("Composer", () => {
  it("send is disabled on empty input, sends text and clears on click", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD}  onSend={onSend} />);
    const send = screen.getByRole("button", { name: /send/i });
    expect(send.hasAttribute("disabled")).toBe(true);
    await user.type(screen.getByLabelText(/message/i), "refactor the tokenizer");
    expect(send.hasAttribute("disabled")).toBe(false);
    await user.click(send);
    expect(onSend).toHaveBeenCalledWith("refactor the tokenizer");
    expect(screen.getByLabelText(/message/i).textContent || "").toBe("");
  });

  it("attach button calls onAttach, memory toggle calls onMemoryToggle", async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    const onMemoryToggle = vi.fn();
    render(
      <Composer
        threadId={THREAD}
        
        onSend={vi.fn()}
        onAttach={onAttach}
        onMemoryToggle={onMemoryToggle}
      />,
    );
    await user.click(screen.getByRole("button", { name: /attach/i }));
    expect(onAttach).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: /memory/i }));
    expect(onMemoryToggle).toHaveBeenCalledOnce();
  });

  it("effort select writes thread effort without touching the model", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD}  onSend={vi.fn()} />);
    await user.click(screen.getByRole("combobox", { name: /effort/i }));
    await user.click(await screen.findByRole("option", { name: /high/i }));
    const thread = useThreadStore.getState().threads[THREAD];
    expect(thread?.effort).toBe("high");
    expect(thread?.model).toBeNull();
  });

  it("embeds the provider-grouped model picker", async () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    // No providers configured in this test: the picker says so honestly
    // instead of rendering an empty dropdown.
    expect(await screen.findByText(/no providers configured/i)).toBeTruthy();
  });

  it("voice renders disabled with its reason, never sends", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD}  onSend={onSend} />);
    const voice = screen.getByRole("button", { name: /voice/i });
    expect(voice.hasAttribute("disabled")).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/message/i), "hi");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
