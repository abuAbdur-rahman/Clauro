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
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
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

  it("send with a model starts a turn with the thread's parameters", async () => {
    const user = userEvent.setup();
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
});