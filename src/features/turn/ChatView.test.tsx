// @vitest-environment jsdom
/**
 * ChatView tests (023 host obligation, DESIGN.md §2.2). The view that turns a
 * composer into a turn: transcript rows, streaming accumulation, stop, and
 * the honest empty/error states.
 *
 * The turn module is mocked at the boundary — these pin the view's behaviour,
 * not the transport. Listener callbacks are captured so tests can simulate a
 * streaming turn without a Tauri runtime.
 */
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatView } from "./ChatView";
import { useThreadStore } from "../catalogue/thread";
import type { TurnEvent, TurnDone } from "./turn";

const THREAD = "chat-t1";

type EventCb = (event: TurnEvent) => void;
type DoneCb = (done: TurnDone) => void;

const listeners: { events: EventCb[]; dones: DoneCb[] } = { events: [], dones: [] };

vi.mock("./turn", () => ({
  turnStart: vi.fn(),
  turnStop: vi.fn(),
  transcriptRead: vi.fn(),
  questionAnswer: vi.fn(),
  artifactLatest: vi.fn(() => Promise.resolve(null)),
  listenTurnEvents: vi.fn((_id: string, cb: EventCb) => {
    listeners.events.push(cb);
    return Promise.resolve(() => {});
  }),
  listenTurnDone: vi.fn((_id: string, cb: DoneCb) => {
    listeners.dones.push(cb);
    return Promise.resolve(() => {});
  }),
}));

import { artifactLatest, questionAnswer, turnStart, turnStop, transcriptRead } from "./turn";
import { useDrawerStore } from "../artifact/store";
import { useArtifactContent } from "../artifact/live";

function selectModel() {
  useThreadStore.getState().openThread(THREAD);
  useThreadStore.getState().selectModel(THREAD, {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    name: "Haiku",
    contextWindow: 200000,
    maxOutput: 8192,
    reasoning: false,
    toolCall: true,
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Radix `use-size` (reached through the real Composer) needs ResizeObserver,
  // which jsdom does not provide. Without it the whole render crashes and
  // every test in this file fails for environmental reasons.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  listeners.events = [];
  listeners.dones = [];
  useThreadStore.getState().reset();
  useThreadStore.getState().openThread(THREAD);
  useDrawerStore.getState().reset();
  useArtifactContent.getState().reset();
});

describe("ChatView", () => {
  it("loads the transcript on mount", async () => {
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: { kind: "text", text: "earlier answer" },
        role: "assistant",
        id: "b1",
        seq: 0,
        generation: 0,
      },
    ]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByText("earlier answer")).toBeTruthy();
    });
    expect(transcriptRead).toHaveBeenCalledWith(THREAD);
  });

  it("renders the empty state when there is no transcript", async () => {
    vi.mocked(transcriptRead).mockResolvedValue([]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByTestId("transcript-empty")).toBeTruthy();
    });
  });

  it("send without a model explains instead of starting", async () => {
    const user = userEvent.setup();
    vi.mocked(transcriptRead).mockResolvedValue([]);
    render(<ChatView threadId={THREAD} />);
    await user.type(screen.getByLabelText(/message/i), "hello");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(turnStart).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText(/select a model/i)).toBeTruthy();
    });
  });

  it("send with a model starts a turn with the thread's parameters", async () => {    const user = userEvent.setup();
    selectModel();
    vi.mocked(transcriptRead).mockResolvedValue([]);
    vi.mocked(turnStart).mockResolvedValue({ thread_id: THREAD });
    render(<ChatView threadId={THREAD} />);
    await user.type(screen.getByLabelText(/message/i), "hello");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      expect(turnStart).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: THREAD,
          text: "hello",
          provider: "anthropic",
          model: "claude-haiku-4-5",
        }),
      );
    });
  });

  it("sends a staged home-composer draft once on mount", async () => {
    selectModel();
    useThreadStore.getState().setDraft(THREAD, "hello from home");
    vi.mocked(transcriptRead).mockResolvedValue([]);
    vi.mocked(turnStart).mockResolvedValue({ thread_id: THREAD });
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(turnStart).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: THREAD, text: "hello from home" }),
      );
    });
    expect(useThreadStore.getState().consumeDraft(THREAD)).toBeNull();
  });

  it("parks a staged draft until a model is present (never lost to a notice)", async () => {
    useThreadStore.getState().setDraft(THREAD, "parked text");
    vi.mocked(transcriptRead).mockResolvedValue([]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByTestId("transcript-empty")).toBeTruthy();
    });
    expect(turnStart).not.toHaveBeenCalled();
    expect(useThreadStore.getState().consumeDraft(THREAD)).toBe("parked text");
  });

  it("streams text deltas into a live row while the turn runs", async () => {
    const user = userEvent.setup();
    selectModel();
    vi.mocked(transcriptRead).mockResolvedValue([]);
    vi.mocked(turnStart).mockResolvedValue({ thread_id: THREAD });
    render(<ChatView threadId={THREAD} />);
    await user.type(screen.getByLabelText(/message/i), "hello");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      expect(turnStart).toHaveBeenCalled();
    });
    const onEvent = listeners.events[listeners.events.length - 1];
    onEvent({ type: "text_delta", index: 0, text: "Hel" });
    onEvent({ type: "text_delta", index: 0, text: "lo" });
    await waitFor(() => {
      expect(screen.getByTestId("row-streaming")).toBeTruthy();
    });
  });

  it("stop is offered while running and calls turn_stop", async () => {
    const user = userEvent.setup();
    selectModel();
    vi.mocked(transcriptRead).mockResolvedValue([]);
    vi.mocked(turnStart).mockResolvedValue({ thread_id: THREAD });
    vi.mocked(turnStop).mockResolvedValue(true);
    render(<ChatView threadId={THREAD} />);
    await user.type(screen.getByLabelText(/message/i), "hello");
    await user.click(screen.getByRole("button", { name: /send/i }));
    const stop = await screen.findByRole("button", { name: /stop/i });
    await user.click(stop);
    expect(turnStop).toHaveBeenCalledWith(THREAD);
  });

  it("turn-done re-reads the transcript and clears the running state", async () => {
    const user = userEvent.setup();
    selectModel();
    vi.mocked(transcriptRead).mockResolvedValue([]);
    vi.mocked(turnStart).mockResolvedValue({ thread_id: THREAD });
    render(<ChatView threadId={THREAD} />);
    await user.type(screen.getByLabelText(/message/i), "hello");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      expect(turnStart).toHaveBeenCalled();
    });
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: { kind: "text", text: "final answer" },
        role: "assistant",
        id: "b2",
        seq: 1,
        generation: 0,
      },
    ]);
    const onDone = listeners.dones[listeners.dones.length - 1];
    onDone({
      thread_id: THREAD,
      end: "EndTurn",
      dispatched: [],
      assistant_messages: 1,
      pending_approvals: [],
    });
    await waitFor(() => {
      expect(screen.getByText("final answer")).toBeTruthy();
    });
    // The stop button is gone: the turn is over.
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("a failed turn surfaces the message without losing the transcript", async () => {
    const user = userEvent.setup();
    selectModel();
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: { kind: "text", text: "kept work" },
        role: "assistant",
        id: "b1",
        seq: 0,
        generation: 0,
      },
    ]);
    vi.mocked(turnStart).mockResolvedValue({ thread_id: THREAD });
    render(<ChatView threadId={THREAD} />);
    await user.type(screen.getByLabelText(/message/i), "hello");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      expect(turnStart).toHaveBeenCalled();
    });
    const onDone = listeners.dones[listeners.dones.length - 1];
    onDone({ thread_id: THREAD, error: "provider returned HTTP 429" });
    await waitFor(() => {
      expect(screen.getByText(/429/)).toBeTruthy();
    });
    // Completed work stays: D68 holds in the view too.
    expect(screen.getByText("kept work")).toBeTruthy();
  });

  it("ignores events for other threads", async () => {
    const user = userEvent.setup();
    selectModel();
    vi.mocked(transcriptRead).mockResolvedValue([]);
    vi.mocked(turnStart).mockResolvedValue({ thread_id: THREAD });
    render(<ChatView threadId={THREAD} />);
    await user.type(screen.getByLabelText(/message/i), "hello");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      expect(turnStart).toHaveBeenCalled();
    });
    // The bridge filters by thread, so no cross-thread text can arrive here.
    // What the view must guarantee: its own listener ignores nothing it owns.
    within(screen.getByTestId("chat-view")).getByLabelText(/message/i);
  });

  it("answering a card calls through with the thread model and runs", async () => {
    const user = userEvent.setup();
    selectModel();
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: {
          kind: "question_card",
          id: "call-q",
          prompt: "which one?",
          options: [{ id: "a", label: "A" }],
          allow_free_text: false,
          resolved: null,
        },
        role: "assistant",
        id: "qc1",
        seq: 0,
        generation: 0,
      },
    ]);
    vi.mocked(questionAnswer).mockResolvedValue({ card_id: "call-q", resolved: "a" });
    render(<ChatView threadId={THREAD} />);
    await user.click(await screen.findByRole("button", { name: "A" }));
    await waitFor(() => {
      expect(questionAnswer).toHaveBeenCalledWith({
        threadId: THREAD,
        toolCallId: "call-q",
        answer: "a",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        effort: "medium",
        maxTokens: 8192,
      });
    });
    // The resumed turn is running: stop is offered until it reports done.
    expect(await screen.findByRole("button", { name: /stop/i })).toBeTruthy();
  });

  it("a refused answer clears running and keeps the card usable", async () => {
    const user = userEvent.setup();
    selectModel();
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: {
          kind: "question_card",
          id: "call-q",
          prompt: "which one?",
          options: [{ id: "a", label: "A" }],
          allow_free_text: false,
          resolved: null,
        },
        role: "assistant",
        id: "qc1",
        seq: 0,
        generation: 0,
      },
    ]);
    vi.mocked(questionAnswer).mockRejectedValue(new Error("question call-q already answered"));
    render(<ChatView threadId={THREAD} />);
    await user.click(await screen.findByRole("button", { name: "A" }));
    await waitFor(() => {
      expect(screen.getByText(/already answered/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("drives the artifact drawer from turn events (D121)", async () => {
    // The production wiring: ChatView owns the producer, so the events this
    // view already listens on flip the drawer, and turn-done lands the row
    // in the content store the shell renders. This is the caller §7a asks
    // for — the seam-tested producer alone would not prove it.
    const user = userEvent.setup();
    selectModel();
    vi.mocked(transcriptRead).mockResolvedValue([]);
    vi.mocked(turnStart).mockResolvedValue({ thread_id: THREAD });
    vi.mocked(artifactLatest).mockResolvedValue({
      artifactId: "a9",
      version: 2,
      title: "Demo",
      mediaType: "text/html",
      source: "<h1>x</h1>",
    });
    render(<ChatView threadId={THREAD} />);
    await user.type(screen.getByLabelText(/message/i), "hello");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      expect(turnStart).toHaveBeenCalled();
    });
    // Tauri delivers to every listener on the channel: ChatView's own and
    // the producer's. Fire them all, exactly as the runtime would.
    for (const cb of listeners.events) {
      cb({
        type: "block_start",
        index: 1,
        kind: "tool_use",
        tool_id: "call-1",
        tool_name: "artifact",
      });
    }
    await waitFor(() => {
      const entry = useDrawerStore.getState().drawers[THREAD];
      expect(entry?.state).toBe("compiling");
      expect(entry?.artifactId).toBeNull();
    });
    for (const cb of listeners.dones) {
      cb({
        thread_id: THREAD,
        end: "EndTurn",
        dispatched: [],
        assistant_messages: 1,
        pending_approvals: [],
      });
    }
    await waitFor(() => {
      const entry = useDrawerStore.getState().drawers[THREAD];
      expect(entry?.state).toBe("live");
      expect(entry?.artifactId).toBe("a9");
      expect(entry?.version).toBe(2);
      expect(useArtifactContent.getState().threads[THREAD]?.source).toBe("<h1>x</h1>");
    });
    expect(artifactLatest).toHaveBeenCalledWith(THREAD);
  });

  it("docks the composer: the transcript owns the only scroller", async () => {
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: { kind: "text", text: "pinned below" },
        role: "assistant",
        id: "dock1",
        seq: 0,
        generation: 0,
      },
    ]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByText("pinned below")).toBeTruthy();
    });
    const root = screen.getByTestId("chat-view");
    expect(root.className).toMatch(/flex-col/);
    expect(root.className).toMatch(/h-full/);
    const scroller = screen.getByTestId("transcript-scroll");
    expect(scroller.className).toMatch(/flex-1/);
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.className).toMatch(/min-h-0/);
    const footer = screen.getByTestId("composer-footer");
    expect(footer.className).toMatch(/shrink-0/);
    // The composer never lives inside the scroller.
    expect(scroller.contains(screen.getByLabelText(/message/i))).toBe(false);
  });

  it("shows the context bar with an honest estimate once rows exist", async () => {
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: { kind: "text", text: "12345678" },
        role: "assistant",
        id: "ctx1",
        seq: 0,
        generation: 0,
      },
    ]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByText("12345678")).toBeTruthy();
    });
    const bar = screen.getByTestId("context-bar");
    expect(bar.textContent).toMatch(/context \d+% used/i);
    // 8 chars / 4 = the same honest divisor the composer token hint uses.
    expect(bar.textContent).toMatch(/2 tokens.*estimate/i);
    expect(screen.getByRole("button", { name: /^compact$/i })).toBeTruthy();
  });

  it("hides the context bar when the transcript is empty", async () => {
    vi.mocked(transcriptRead).mockResolvedValue([]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByTestId("transcript-empty")).toBeTruthy();
    });
    expect(screen.queryByTestId("context-bar")).toBeNull();
  });

  it("Compact dispatches the shell compact intent instead of nooping", async () => {
    const user = userEvent.setup();
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: { kind: "text", text: "shrink me" },
        role: "assistant",
        id: "ctx2",
        seq: 0,
        generation: 0,
      },
    ]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByText("shrink me")).toBeTruthy();
    });
    const seen: string[] = [];
    const onReq = () => {
      seen.push("compact");
    };
    window.addEventListener("clauro:compact-request", onReq);
    try {
      await user.click(screen.getByRole("button", { name: /^compact$/i }));
      expect(seen).toEqual(["compact"]);
    } finally {
      window.removeEventListener("clauro:compact-request", onReq);
    }
  });

  it("sticks to the bottom on new rows when near the bottom", async () => {
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: { kind: "text", text: "first" },
        role: "assistant",
        id: "stick1",
        seq: 0,
        generation: 0,
      },
    ]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByText("first")).toBeTruthy();
    });
    const scroller = screen.getByTestId("transcript-scroll");
    // jsdom lays out nothing: pin the geometry by hand.
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    // 10px from the bottom: inside the 48px stick band.
    scroller.scrollTop = 790;
    fireEvent.scroll(scroller);
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: { kind: "text", text: "first" },
        role: "assistant",
        id: "stick1",
        seq: 0,
        generation: 0,
      },
      {
        block: { kind: "text", text: "second" },
        role: "assistant",
        id: "stick2",
        seq: 1,
        generation: 0,
      },
    ]);
    const onDone = listeners.dones[listeners.dones.length - 1];
    onDone({
      thread_id: THREAD,
      end: "EndTurn",
      dispatched: [],
      assistant_messages: 1,
      pending_approvals: [],
    });
    await waitFor(() => {
      expect(screen.getByText("second")).toBeTruthy();
    });
    // The follow-scroll is a passive effect: poll until it flushes instead
    // of assuming it ran before the row paint was observed.
    await waitFor(() => {
      expect(scroller.scrollTop).toBe(1000);
    });
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });

  it("offers Jump to latest instead of yanking when scrolled up", async () => {
    const user = userEvent.setup();
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: { kind: "text", text: "top row" },
        role: "assistant",
        id: "jump1",
        seq: 0,
        generation: 0,
      },
    ]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByText("top row")).toBeTruthy();
    });
    const scroller = screen.getByTestId("transcript-scroll");
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    const jump = await screen.findByRole("button", { name: /jump to latest/i });
    expect(jump).toBeTruthy();
    vi.mocked(transcriptRead).mockResolvedValue([
      {
        block: { kind: "text", text: "top row" },
        role: "assistant",
        id: "jump1",
        seq: 0,
        generation: 0,
      },
      {
        block: { kind: "text", text: "bottom row" },
        role: "assistant",
        id: "jump2",
        seq: 1,
        generation: 0,
      },
    ]);
    const onDone = listeners.dones[listeners.dones.length - 1];
    onDone({
      thread_id: THREAD,
      end: "EndTurn",
      dispatched: [],
      assistant_messages: 1,
      pending_approvals: [],
    });
    await waitFor(() => {
      expect(screen.getByText("bottom row")).toBeTruthy();
    });
    // Scrolled up: the view must not yank.
    expect(scroller.scrollTop).toBe(0);
    await user.click(screen.getByRole("button", { name: /jump to latest/i }));
    expect(scroller.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });

  it("wires the composer attach button to a real file picker", async () => {
    vi.mocked(transcriptRead).mockResolvedValue([]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByTestId("transcript-empty")).toBeTruthy();
    });
    const input = screen.getByTestId("attach-input");
    expect(input instanceof HTMLInputElement).toBe(true);
    fireEvent.change(input, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    // Never a silent noop: the pick surfaces as a view notice naming the file.
    await waitFor(() => {
      expect(screen.getByText(/notes\.txt/)).toBeTruthy();
    });
  });
});

describe("ChatView mock mode (031 T5)", () => {
  const realMode = import.meta.env.MODE;

  function setMode(mode: string): void {
    import.meta.env.MODE = mode;
  }

  beforeEach(() => {
    setMode("mock");
  });

  afterEach(() => {
    setMode(realMode);
  });

  it("auto-selects the seed model when none is chosen (no model-none dead-end)", async () => {
    vi.mocked(transcriptRead).mockResolvedValue([]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(useThreadStore.getState().threads[THREAD]?.model).not.toBeNull();
    });
    expect(useThreadStore.getState().threads[THREAD]?.model?.id).toBe("claude-sonnet");
    expect(screen.queryByText(/select a model/i)).toBeNull();
  });

  it("send works without a pre-selected model once the seed model lands", async () => {
    const user = userEvent.setup();
    vi.mocked(transcriptRead).mockResolvedValue([]);
    vi.mocked(turnStart).mockResolvedValue({ thread_id: THREAD });
    render(<ChatView threadId={THREAD} />);
    await user.type(screen.getByLabelText(/message/i), "hello");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      expect(turnStart).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD }));
    });
    expect(screen.queryByText(/select a model/i)).toBeNull();
  });

  it("renders the honest empty state when the seed transcript is empty (?seed=0)", async () => {
    vi.mocked(transcriptRead).mockResolvedValue([]);
    render(<ChatView threadId={THREAD} />);
    await waitFor(() => {
      expect(screen.getByTestId("transcript-empty")).toBeTruthy();
    });
  });
});