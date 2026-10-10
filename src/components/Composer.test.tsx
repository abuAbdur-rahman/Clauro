// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
  },
  // Interaction-heavy: user-event keystroke delays exceed the 5s default
  // under full-suite parallel load (passes in isolation in ~1s).
  30000);

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

  it("shows a live honest token estimate next to send", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    expect(screen.getByTestId("token-hint").textContent).toMatch(/0 tokens.*estimate/i);
    await user.type(screen.getByLabelText(/message/i), "12345678");
    expect(screen.getByTestId("token-hint").textContent).toMatch(/2 tokens.*estimate/i);
  });

  it("caps textarea growth with a max height and scroll", () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = screen.getByLabelText(/message/i);
    expect(box.className).toMatch(/max-h-/);
    expect(box.className).toMatch(/overflow-y-auto/);
  });

  it("shift+enter makes a newline in enter mode, ctrl+enter sends in ctrl mode", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = screen.getByLabelText(/message/i);
    await user.type(box, "a");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("a");

    cleanup();
    const onCtrlSend = vi.fn();
    render(<Composer threadId={THREAD} sendWith="ctrl" onSend={onCtrlSend} />);
    const box2 = screen.getByLabelText(/message/i);
    await user.type(box2, "b");
    fireEvent.keyDown(box2, { key: "Enter" });
    expect(onCtrlSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box2, { key: "Enter", ctrlKey: true });
    expect(onCtrlSend).toHaveBeenCalledWith("b");
  });

  it("ime composition guards enter-to-send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = screen.getByLabelText(/message/i);
    await user.type(box, "x");
    fireEvent.compositionStart(box);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.compositionEnd(box);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("x");
  });

  it("swaps send for stop in place while running, keeps typing enabled", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<Composer threadId={THREAD} onSend={vi.fn()} running onStop={onStop} />);
    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
    expect(screen.getByLabelText(/message/i).hasAttribute("disabled")).toBe(false);
    await user.click(screen.getByRole("button", { name: /stop/i }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("slash menu filters, arrows wrap, enter runs /compact, esc closes", async () => {
    const user = userEvent.setup();
    const onCompact = vi.fn();
    const onSlashCommand = vi.fn();
    render(
      <Composer
        threadId={THREAD}
        onSend={vi.fn()}
        onCompact={onCompact}
        onSlashCommand={onSlashCommand}
      />,
    );
    const box = screen.getByLabelText(/message/i);
    await user.type(box, "/");
    expect(screen.getByRole("listbox", { name: /commands/i })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(6);
    await user.type(box, "comp");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onCompact).toHaveBeenCalledOnce();
    expect(onSlashCommand).toHaveBeenCalledWith("compact");
    expect(box instanceof HTMLTextAreaElement ? box.value : null).toBe("");

    await user.type(box, "/");
    expect(screen.getAllByRole("option")).toHaveLength(6);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: /commands/i })).toBeNull();
    expect(box instanceof HTMLTextAreaElement ? box.value : null).toBe("/");
  });

  it("ctrl+b/i/e and ctrl+shift+k wrap the selection", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const el = screen.getByLabelText(/message/i);
    if (!(el instanceof HTMLTextAreaElement)) throw new Error("expected textarea");
    const box: HTMLTextAreaElement = el;
    await user.type(box, "hello");
    box.setSelectionRange(0, 5);
    fireEvent.keyDown(box, { key: "b", ctrlKey: true });
    expect(box.value).toBe("**hello**");
    box.setSelectionRange(2, 7);
    fireEvent.keyDown(box, { key: "i", ctrlKey: true });
    expect(box.value).toBe("***hello***");
    box.setSelectionRange(0, 11);
    fireEvent.keyDown(box, { key: "e", ctrlKey: true });
    expect(box.value).toBe("`***hello***`");
  });

});
