// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Composer from "./Composer";
import { continueList, fenceLanguage, isInsideFence } from "./Composer";
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

function messageBox(): HTMLTextAreaElement {
  const el = screen.getByLabelText(/message/i);
  if (!(el instanceof HTMLTextAreaElement)) throw new Error("expected textarea");
  return el;
}

beforeEach(() => {
  cleanup();
  // Prefs (clauro.prefs.sendWith) are global: without this one test's
  // setting would rewire the next test's Enter key.
  localStorage.clear();
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

  it("attach opens a real file picker and forwards files to onAttach", async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn<(files: File[]) => void>();
    const onMemoryToggle = vi.fn();
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    try {
      render(
        <Composer
          threadId={THREAD}

          onSend={vi.fn()}
          onAttach={onAttach}
          onMemoryToggle={onMemoryToggle}
        />,
      );
      await user.click(screen.getByRole("button", { name: /attach/i }));
      expect(clickSpy).toHaveBeenCalled();
      const input = screen.getByTestId("attach-input");
      expect(input instanceof HTMLInputElement).toBe(true);
      if (!(input instanceof HTMLInputElement)) throw new Error("expected file input");
      expect(input.type).toBe("file");
      const file = new File(["hello"], "notes.txt", { type: "text/plain" });
      fireEvent.change(input, { target: { files: [file] } });
      expect(onAttach).toHaveBeenCalledOnce();
      expect(onAttach.mock.calls[0]?.[0].map((f) => f.name)).toEqual(["notes.txt"]);
      await user.click(screen.getByRole("button", { name: /memory/i }));
      expect(onMemoryToggle).toHaveBeenCalledOnce();
    } finally {
      clickSpy.mockRestore();
    }
  });

  it("attach renders disabled with its reason when onAttach is missing", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /attach/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
    await user.hover(btn);
    expect(await screen.findByText(/attachments are not available here yet/i)).toBeTruthy();
  });

  it("effort select is a thinking-level indicator writing thread effort", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD}  onSend={vi.fn()} />);
    const trigger = screen.getByRole("combobox", { name: /thinking level/i });
    await user.hover(trigger);
    expect(await screen.findByText(/thinking level — request params only/i)).toBeTruthy();
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: /high/i }));
    const thread = useThreadStore.getState().threads[THREAD];
    expect(thread?.effort).toBe("high");
    expect(thread?.model).toBeNull();
  });

  it("memory toggle is an icon-only Brain button carrying its state in the tooltip", async () => {
    const user = userEvent.setup();
    const onMemoryToggle = vi.fn();
    render(<Composer threadId={THREAD} onSend={vi.fn()} onMemoryToggle={onMemoryToggle} />);
    const btn = screen.getByRole("button", { name: /^memory$/i });
    // Icon-only: no visible text label, the tooltip carries "Memory on/off".
    expect(btn.textContent).toBe("");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    await user.hover(btn);
    expect(await screen.findByText("Memory on")).toBeTruthy();
    await user.click(btn);
    expect(onMemoryToggle).toHaveBeenCalledOnce();

    cleanup();
    render(
      <Composer threadId={THREAD} memoryOff onSend={vi.fn()} onMemoryToggle={vi.fn()} />,
    );
    const off = screen.getByRole("button", { name: /^memory$/i });
    expect(off.textContent).toBe("");
    expect(off.getAttribute("aria-pressed")).toBe("true");
    await user.hover(off);
    expect(await screen.findByText("Memory off")).toBeTruthy();
  });

  it("web search is an icon-only toggle, on by default", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /web search/i });
    expect(btn.textContent).toBe("");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    await user.hover(btn);
    expect(await screen.findByText("Web search on")).toBeTruthy();
    await user.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("send and stop are round icon buttons with tooltips", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const send = screen.getByRole("button", { name: /^send$/i });
    expect(send.className).toMatch(/rounded-full/);
    await user.hover(send);
    expect(await screen.findByText(/^Send$/)).toBeTruthy();

    cleanup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} running onStop={vi.fn()} />);
    const stop = screen.getByRole("button", { name: /^stop$/i });
    expect(stop.className).toMatch(/rounded-full/);
  });

  it("token hint meets the contrast floor", () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const hint = screen.getByTestId("token-hint");
    // The floor itself is a colour number, so it lives where colours are
    // computed: contrast.test.ts pins muted-foreground ≥ 4.5:1 in both
    // themes. This pins the wiring — the hint rides the token, never a raw
    // ramp class (review 61 P1 / 33).
    expect(hint.className).toMatch(/text-muted-foreground/);
    expect(hint.className).not.toMatch(/neutral-\d/);
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

  it("a markdown chord during IME composition is left to the IME", () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    fireEvent.change(box, { target: { value: "かな" } });
    box.setSelectionRange(2, 2);
    fireEvent.compositionStart(box);
    // Mid-composition Ctrl+B belongs to the IME: no preventDefault, no edit.
    const notPrevented = fireEvent.keyDown(box, { key: "b", ctrlKey: true });
    expect(notPrevented).toBe(true);
    expect(box.value).toBe("かな");
    // After the composition ends the shortcut works again.
    fireEvent.compositionEnd(box);
    box.setSelectionRange(0, 2);
    fireEvent.keyDown(box, { key: "b", ctrlKey: true });
    expect(box.value).toBe("**かな**");
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

  it("an unwired slash command keeps the typed draft instead of eating it", async () => {
    const user = userEvent.setup();
    const onCompact = vi.fn();
    // No onSlashCommand: /clear is dispatched nowhere, so the handler must
    // stand down and leave the typed draft intact (review 30, runSlash).
    render(<Composer threadId={THREAD} onSend={vi.fn()} onCompact={onCompact} />);
    const box = messageBox();
    await user.type(box, "/clear");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("/clear");
    expect(onCompact).not.toHaveBeenCalled();
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

describe("Composer code fences (Task 032 follow-up)", () => {
  it("fenceLanguage accepts bare + valid langs, rejects the rest", () => {
    expect(fenceLanguage("```")).toBe("");
    expect(fenceLanguage("```rust")).toBe("rust");
    expect(fenceLanguage("```c++  ")).toBe("c++");
    expect(fenceLanguage("```<img>")).toBeNull();
    expect(fenceLanguage("hello ```")).toBeNull();
    expect(fenceLanguage("```rust extra words")).toBeNull();
  });

  it("isInsideFence counts fences before the caret", () => {
    expect(isInsideFence("```js\ncode", 10)).toBe(true);
    expect(isInsideFence("```js\ncode\n```\n", 100)).toBe(false);
    expect(isInsideFence("plain", 5)).toBe(false);
    expect(isInsideFence("```<img>", 7)).toBe(false);
  });

  it("```lang + Enter opens a fence with the cursor inside and a closing fence", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = messageBox();
    await user.type(box, "```rust");
    await user.keyboard("{Enter}");
    expect(box.value).toBe("```rust\n\n```");
    expect(box.selectionStart).toBe("```rust\n".length);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not double-close when a closing fence already lies ahead", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = messageBox();
    await user.type(box, "```rust\n\n```");
    // Move caret to the end of the opener line, then Enter.
    box.setSelectionRange("```rust".length, "```rust".length);
    await user.keyboard("{Enter}");
    expect(box.value).toBe("```rust\n\n\n```");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Enter inside an open fence is a newline, Ctrl+Enter sends", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = messageBox();
    await user.type(box, "```py");
    await user.keyboard("{Enter}");
    await user.keyboard("x");
    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toContain("```py\nx\n");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSend).toHaveBeenCalled();
  });

  it("Tab inside a fence inserts two spaces", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "```js");
    await user.keyboard("{Enter}");
    await user.keyboard("{Tab}");
    expect(box.value).toBe("```js\n  \n```");
  });

  it("pasting code-like multi-line text wraps it as text", () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    fireEvent.paste(box, {
      clipboardData: { getData: () => "function a() {\n  return 1;\n};\nconst b = () => 2;" },
    });
    expect(box.value).toBe("```text\nfunction a() {\n  return 1;\n};\nconst b = () => 2;\n```");
  });

  it("pasting ordinary multi-line prose is left to the browser", () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    const evt = fireEvent.paste(box, {
      clipboardData: { getData: () => "first line\nsecond line" },
    });
    // jsdom performs no default paste, so assert the handler stood down —
    // no preventDefault means the browser inserts the text verbatim.
    expect(evt).toBe(true);
  });

  it("pasting code into a pre-filled draft keeps the draft and fences at the caret", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    // Type so the caret lands at the end the way a real paste does — the
    // handler reads React's caret state, which a bare setSelectionRange
    // would leave stale at 0.
    await user.type(box, "Explain this:");
    fireEvent.paste(box, {
      clipboardData: { getData: () => "function a() {\n  return 1;\n};\nconst b = () => 2;" },
    });
    // The pre-existing draft text must survive; the fence splices after it.
    expect(box.value).toBe(
      "Explain this:```text\nfunction a() {\n  return 1;\n};\nconst b = () => 2;\n```",
    );
  });

  it("pasting code over a selection replaces only the selected span", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "keep-before keep-me keep-after");
    // Select just "keep-me" (chars 12..19). The paste handler reads the DOM
    // selection directly, so setSelectionRange is sufficient and deterministic.
    box.setSelectionRange(12, 19);
    fireEvent.paste(box, {
      clipboardData: { getData: () => "function a() {\n  return 1;\n};\nconst b = () => 2;" },
    });
    // Text either side of the selection survives; only the span is replaced.
    expect(box.value).toBe(
      "keep-before ```text\nfunction a() {\n  return 1;\n};\nconst b = () => 2;\n``` keep-after",
    );
  });

  it("shows a 'Wrapped in code block · Undo' toast when it wraps a paste", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    fireEvent.paste(box, {
      clipboardData: { getData: () => "function a() {\n  return 1;\n};\nconst b = () => 2;" },
    });
    const toast = await screen.findByTestId("paste-toast");
    expect(toast.textContent).toContain("Wrapped in code block");
    expect(within(toast).getByRole("button", { name: /undo/i })).toBeTruthy();
    // Dismiss it so the test does not leak a timer into the next one.
    await user.click(within(toast).getByRole("button", { name: /undo/i }));
  });

  it("Undo on the toast reverts the fenced wrap to the raw pasted text", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    fireEvent.paste(box, {
      clipboardData: { getData: () => "function a() {\n  return 1;\n};\nconst b = () => 2;" },
    });
    const toast = await screen.findByTestId("paste-toast");
    await user.click(within(toast).getByRole("button", { name: /undo/i }));
    expect(box.value).toBe("function a() {\n  return 1;\n};\nconst b = () => 2;");
    expect(screen.queryByTestId("paste-toast")).toBeNull();
  });

  it("shows no toast for a plain prose paste (handler stands down)", () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    fireEvent.paste(box, {
      clipboardData: { getData: () => "first line\nsecond line" },
    });
    expect(screen.queryByTestId("paste-toast")).toBeNull();
  });

  it("the paste toast dismisses itself after its timeout", () => {
    vi.useFakeTimers();
    try {
      render(<Composer threadId={THREAD} onSend={vi.fn()} />);
      const box = messageBox();
      fireEvent.paste(box, {
        clipboardData: { getData: () => "function a() {\n  return 1;\n};\nconst b = () => 2;" },
      });
      expect(screen.getByTestId("paste-toast")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(6001);
      });
      expect(screen.queryByTestId("paste-toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Undo after a paste into a pre-filled draft keeps the draft text", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "Explain this:");
    fireEvent.paste(box, {
      clipboardData: { getData: () => "function a() {\n  return 1;\n};\nconst b = () => 2;" },
    });
    const toast = await screen.findByTestId("paste-toast");
    await user.click(within(toast).getByRole("button", { name: /undo/i }));
    // Only the fence is stripped; the raw pasted text stays spliced into the
    // pre-existing draft.
    expect(box.value).toBe(
      "Explain this:function a() {\n  return 1;\n};\nconst b = () => 2;",
    );
  });

  it("invalid fence language sends normally (no block opens)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = messageBox();
    await user.type(box, "```<img>");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("```<img>");
  });
});

describe("Composer list continuation (Task 032 follow-up)", () => {
  it("continueList increments numbers, keeps bullets, indent and delimiter", () => {
    expect(continueList("1. one", 6)).toEqual({ kind: "continued", text: "1. one\n2. ", caret: 10 });
    expect(continueList("- one", 5)).toEqual({ kind: "continued", text: "- one\n- ", caret: 8 });
    expect(continueList("  3) two", 8)).toEqual({ kind: "continued", text: "  3) two\n  4) ", caret: 14 });
    expect(continueList("plain", 5)).toBeNull();
    expect(continueList("1. one\n2. ", 9)).toEqual({ kind: "finished", text: "1. one\n", caret: 7 });
  });

  it("Shift+Enter on a numbered line continues the list instead of sending", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = messageBox();
    await user.type(box, "1. first");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(box.value).toBe("1. first\n2. ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Shift+Enter on an empty item ends the list", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "1. first");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(box.value).toBe("1. first\n");
  });

  it("Enter mid list line is a plain newline, not a fabricated next item", () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    fireEvent.change(box, { target: { value: "1. hello" } });
    // Collapsed caret mid-line (char 5): continuing would produce the
    // nonsense item "2. llo" out of the line's tail (review 33).
    box.setSelectionRange(5, 5);
    fireEvent.select(box);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("1. he\nllo");
  });

  it("plain Enter on a list line continues instead of sending", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = messageBox();
    await user.type(box, "1. first");
    await user.keyboard("{Enter}");
    expect(box.value).toBe("1. first\n2. ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("plain Enter on the trailing empty marker strips it and exits; next Enter sends", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = messageBox();
    await user.type(box, "1. first");
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    // Spec B: the empty marker is removed, the list exits, nothing sends.
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toBe("1. first\n");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("1. first");
  });
});

describe("Composer spec B — list Tab mechanics (COMPOSER_MARKDOWN_SPEC)", () => {
  it("Tab on a list line indents 2 spaces, restarting numbers at 1", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "3. third");
    await user.keyboard("{Tab}");
    expect(box.value).toBe("  1. third");
  });

  it("Shift+Tab outdents a list line", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "  - item");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(box.value).toBe("- item");
  });

  it("Tab on a non-list line outside a fence moves focus (not intercepted)", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "plain text");
    const before = box.value;
    await user.keyboard("{Tab}");
    expect(box.value).toBe(before);
  });

  it("continues task lists, unchecking the next item", () => {
    expect(continueList("- [x] done", 10)).toEqual({
      kind: "continued",
      text: "- [x] done\n- [ ] ",
      caret: 17,
    });
    expect(continueList("- [ ] todo", 10)).toEqual({
      kind: "continued",
      text: "- [ ] todo\n- [ ] ",
      caret: 17,
    });
  });

  it("continues block quotes and two-digit numbers", () => {
    expect(continueList("> quoted", 8)).toEqual({
      kind: "continued",
      text: "> quoted\n> ",
      caret: 11,
    });
    expect(continueList("9. nine", 7)).toEqual({
      kind: "continued",
      text: "9. nine\n10. ",
      caret: 12,
    });
  });
});

describe("Composer spec A — fence edge keys (COMPOSER_MARKDOWN_SPEC)", () => {
  it("Space on an opener line auto-closes the block", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = messageBox();
    await user.type(box, "```js");
    await user.keyboard(" ");
    // The typed space is kept on the opener line — never swallowed into the
    // opening newline (review 15) — and the block still opens with the
    // cursor on the empty middle line.
    expect(box.value).toBe("```js \n\n```");
    expect(box.selectionStart).toBe("```js \n".length);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Space with a closing fence ahead inserts a space, not a newline", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    // Focus first: user.keyboard delivers to the focused element.
    await user.click(box);
    // Set the closed-block state directly (typing would fire Enter keys).
    fireEvent.change(box, { target: { value: "```js\n\n```" } });
    // Caret at the end of the opener line; a closing fence lies ahead.
    box.setSelectionRange(5, 5);
    await user.keyboard(" ");
    // A space keypress must insert a space — previously it became "\n".
    expect(box.value).toBe("```js \n\n```");
    expect(box.selectionStart).toBe(6);
  });

  it("Alt+Space on a ```lang opener stands down (the OS keeps the chord)", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "```js");
    const notPrevented = fireEvent.keyDown(box, { key: " ", altKey: true });
    // No preventDefault: Alt+Space stays a system chord (window menu).
    expect(notPrevented).toBe(true);
    expect(box.value).toBe("```js");
  });

  it("Enter on the closing fence line sends (leaves the block)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = messageBox();
    // Focus first: fireEvent.change does not focus, so a bare user.keyboard
    // would deliver Enter to the body, not the textarea.
    await user.click(box);
    // Set the closed-block state directly (typing \n would fire Enter keys).
    fireEvent.change(box, { target: { value: "```ts\nconst a = 1;\n```" } });
    // Caret sits at the end of the closing fence line — that Enter leaves.
    box.setSelectionRange(box.value.length, box.value.length);
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("```ts\nconst a = 1;\n```");
  });

  it("Enter inside a fence keeps the current line indent", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "```py");
    await user.keyboard("{Enter}");
    // keyboard, not type: user.type re-focuses and resets the restored caret.
    await user.keyboard("  x = 1");
    await user.keyboard("{Enter}");
    expect(box.value).toBe("```py\n  x = 1\n  \n```");
  });

  it("Shift+Tab inside a fence removes up to 2 leading spaces", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "```js");
    await user.keyboard("{Enter}");
    await user.keyboard("    deep");
    box.setSelectionRange("```js\n".length, "```js\n".length);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(box.value).toBe("```js\n  deep\n```");
  });

  it("Backspace on an empty fenced block removes the whole block", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "```rust");
    await user.keyboard("{Enter}");
    // Caret on the empty middle line; closing fence lies ahead.
    await user.keyboard("{Backspace}");
    expect(box.value).toBe("");
  });

  it("a backtick with a selection wraps it", () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    fireEvent.change(box, { target: { value: "selected" } });
    box.setSelectionRange(0, 8);
    fireEvent.keyDown(box, { key: "`" });
    expect(box.value).toBe("`selected`");
  });

  it("Ctrl+Shift+K puts the caret on the language line", () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    fireEvent.change(box, { target: { value: "let x = 1;" } });
    box.setSelectionRange(0, 10);
    fireEvent.keyDown(box, { key: "k", ctrlKey: true, shiftKey: true });
    expect(box.value).toBe("```\nlet x = 1;\n```");
    expect(box.selectionStart).toBe(3);
  });

  it("Ctrl+Shift+K with a partial selection keeps the text outside it", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "before after");
    // Select only "after" (chars 7..12); fireEvent.select is what notifies
    // React's onSelect (and thus the caret state the handler reads).
    box.setSelectionRange(7, 12);
    fireEvent.select(box);
    fireEvent.keyDown(box, { key: "k", ctrlKey: true, shiftKey: true });
    expect(box.value).toBe("before ```\nafter\n```");
    expect(box.selectionStart).toBe(10);
  });
});

describe("Composer spec A — fence status label", () => {
  it("shows 'Code block · Ctrl+Enter to send' while inside a fence", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    expect(screen.queryByTestId("fence-hint")).toBeNull();
    await user.type(box, "```rust");
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("fence-hint").textContent).toBe("Code block · Ctrl+Enter to send");
    // Closing the block hides it again. keyboard, not type (see above); the
    // braces are escaped so user-event treats them as literal characters.
    await user.keyboard("fn main() {{}}");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.queryByTestId("fence-hint")).toBeNull();
  });
});

describe("Composer spec E — live preview", () => {
  it("is off by default", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "# Hello");
    expect(screen.queryByTestId("composer-preview")).toBeNull();
  });

  it("Ctrl+Shift+P toggles a rendered preview above the textarea", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "**bold**");
    await user.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
    const preview = await screen.findByTestId("composer-preview");
    // Rendered markdown: a <strong> holds "bold", the raw asterisks are gone.
    expect(preview.querySelector("strong")?.textContent).toBe("bold");
    expect(preview.textContent).not.toContain("**");
    // The textarea keeps the raw markdown (what gets sent).
    expect(box.value).toBe("**bold**");
  });

  it("the eye toggle turns preview on and off", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    await user.type(box, "- one");
    const eye = screen.getByRole("button", { name: /toggle live preview/i });
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    await user.click(eye);
    expect((await screen.findByTestId("composer-preview")).textContent).toContain("one");
    expect(screen.getByRole("button", { name: /toggle live preview/i }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: /toggle live preview/i }));
    expect(screen.queryByTestId("composer-preview")).toBeNull();
  });

  it("preview updates live as text changes", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    const box = messageBox();
    const eye = screen.getByRole("button", { name: /toggle live preview/i });
    await user.click(eye);
    await user.type(box, "hi");
    const preview = await screen.findByTestId("composer-preview");
    expect(preview.textContent).toContain("hi");
  });
});

describe("per-thread drafts (review 30 — store composerDrafts)", () => {
  it("restores a stored draft on mount", () => {
    useThreadStore.getState().setComposerDraft(THREAD, "typed earlier");
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    expect(messageBox().value).toBe("typed earlier");
  });

  it("a typed draft survives a switch away and back", async () => {
    const user = userEvent.setup();
    useThreadStore.getState().openThread("composer-t2");
    const view = render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    await user.type(messageBox(), "half-written answer");
    expect(useThreadStore.getState().composerDraft(THREAD)).toBe("half-written answer");
    // Switching threads must not carry this text over — and coming back
    // must not have lost it (the review-30 bug: unmount dropped everything).
    view.rerender(<Composer threadId="composer-t2" onSend={vi.fn()} />);
    expect(messageBox().value).toBe("");
    view.rerender(<Composer threadId={THREAD} onSend={vi.fn()} />);
    expect(messageBox().value).toBe("half-written answer");
  }, 30000);

  it("send clears the stored draft for the thread", async () => {
    const user = userEvent.setup();
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    await user.type(messageBox(), "send this");
    expect(useThreadStore.getState().composerDraft(THREAD)).toBe("send this");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(useThreadStore.getState().composerDraft(THREAD)).toBeNull();
    expect(messageBox().value).toBe("");
  }, 30000);

  it("an external store draft reaches the mounted textarea", async () => {
    render(<Composer threadId={THREAD} onSend={vi.fn()} />);
    // App's suggestion-chip fill is a plain `setComposerDraft` (review 30's
    // DOM-actuation NIT): the mounted composer must adopt an external store
    // write without a thread switch.
    useThreadStore.getState().setComposerDraft(THREAD, "Debug my code");
    await waitFor(() => {
      expect(messageBox().value).toBe("Debug my code");
    });
  });
});

describe("clauro.prefs.sendWith reader (review 30/31 owner TODO)", () => {
  it("pref ctrl: Enter keeps the newline, Ctrl+Enter sends", async () => {
    localStorage.setItem("clauro.prefs.sendWith", "ctrl");
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer threadId={THREAD} onSend={onSend} />);
    const box = messageBox();
    await user.type(box, "hold the line{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toContain("\n");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSend).toHaveBeenCalledWith("hold the line");
  }, 30000);
});
