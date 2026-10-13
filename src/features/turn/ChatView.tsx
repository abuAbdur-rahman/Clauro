/**
 * ChatView: the composer wired to the turn loop (023 host obligation).
 *
 * One thread on screen: transcript rows from the store, a streaming row while
 * a turn runs, the composer, and stop. The store is the record and the event
 * channel is the hint — `transcript_read` runs on mount and on every
 * turn-done, so whatever the channel dropped, the view still converges.
 *
 * A turn with no model selected explains instead of starting: the backend
 * would refuse it as `BadInput`, and the composer should say so before the
 * round-trip, not after.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Composer from "../../components/Composer";
import { ArrowDown } from "lucide-react";
import { Progress } from "../../components/ui/progress";
import { useThreadStore } from "../catalogue/thread";
import { useArtifactProducer } from "../artifact/live";
import { FrameCoalescer } from "../transcript/markdown";
import { TranscriptView, ThinkingRegion } from "../transcript/TranscriptView";
import type { ContentBlock, RenderRow } from "../transcript/types";
import {
  listenTurnDone,
  listenTurnEvents,
  questionAnswer,
  transcriptRead,
  turnStart,
  turnStop,
} from "./turn";

/**
 * Honest context estimate: characters summed across the transcript (plus the
 * live streaming text) over the same ÷4 divisor the composer hint uses.
 */
function rowChars(block: ContentBlock): number {
  switch (block.kind) {
    case "text":
    case "thinking":
    case "notice":
    case "summary":
      return block.text.length;
    case "tool_use":
      return block.input_json.length;
    case "tool_result":
      return block.preview.length;
    case "artifact_ref":
      return block.title.length;
    case "question_card":
      return (
        block.prompt.length +
        (block.options ?? []).reduce((n, o) => n + o.label.length, 0)
      );
    case "compaction":
      return 0;
  }
}

export function ChatView({ threadId }: { threadId: string }): React.JSX.Element {
  const [rows, setRows] = useState<RenderRow[]>([]);
  const [streaming, setStreaming] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const model = useThreadStore((s) => s.threads[threadId]?.model ?? null);
  const streamingRef = useRef("");
  const runningRef = useRef(false);
  // Accumulated thinking-delta text (review 30: the deltas used to be
  // discarded and a fabricated "Thinking…" stub rendered). Kept in a ref —
  // the collapsed region previews it; per-delta re-renders buy nothing.
  const thinkingRef = useRef("");
  // Stick-to-bottom (html truth): the transcript follows new rows only while
  // the reader is near the bottom (<48px). Scrolling up parks the stick and
  // raises "Jump to latest", which scrolls down and resumes it.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);

  // Context bar estimate (html truth): tokens ≈ chars/4 against the thread
  // model's window, labelled as an estimate. Shown only when rows exist.
  const contextWindow = model?.contextWindow ?? 200000;
  const tokens = Math.ceil(
    (rows.reduce((n, r) => n + rowChars(r.block), 0) + streaming.length) / 4,
  );
  const pct = Math.min(100, Math.round((tokens / contextWindow) * 100));

  const refresh = useCallback(async () => {
    try {
      setRows(await transcriptRead(threadId));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [threadId]);

  // The drawer's producer (D121) rides this view's listeners; its failures
  // surface as the same notice as a failed transcript read.
  const onArtifactError = useCallback((reason: string) => {
    setNotice(reason);
  }, []);
  useArtifactProducer(threadId, onArtifactError);

  // Task 031 T5: mock MODE auto-selects the seed model when the thread has
  // none, so mock threads are never stuck on the "model none" dead-end. The
  // seed loads through a dynamic relative import on this branch only — the
  // real bundle stays mock-free (same pattern as App.tsx) and the real path
  // never runs this effect.
  useEffect(() => {
    if (import.meta.env.MODE !== "mock") return;
    if (useThreadStore.getState().threads[threadId] === undefined) {
      useThreadStore.getState().openThread(threadId);
    }
    if (useThreadStore.getState().threads[threadId]?.model != null) return;
    let cancelled = false;
    void import("../../mock/seed").then((mod) => {
      if (cancelled) return;
      const store = useThreadStore.getState();
      if (store.threads[threadId] === undefined) return;
      store.selectModel(threadId, mod.defaultMockModel());
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // Task 031 T8: staged home-composer text sends once a model is present.
  // Consuming only when `model != null` keeps the draft parked (never lost
  // to a "select a model" notice) until the turn can actually start. The
  // effect re-runs only when the thread or its model changes; after the first
  // pickup consumeDraft returns null, so later model switches are no-ops.
  useEffect(() => {
    if (model === null || runningRef.current) return;
    const staged = useThreadStore.getState().consumeDraft(threadId);
    if (staged !== null) {
      void send(staged);
    }
  }, [threadId, model]);

  useEffect(() => {
    // Adopt the store's running flag for this thread (review 30): a turn may
    // outlive a view unmount/remount (switch away and back mid-stream). A
    // fresh local `false` would hide stop and drop the stream on the floor.
    const storeRunning = useThreadStore.getState().running.includes(threadId);
    runningRef.current = storeRunning;
    setRunning(storeRunning);
    setStreaming("");
    streamingRef.current = "";
    thinkingRef.current = "";
    setThinkingText("");
    setNotice(null);
    void refresh();
    let offEvents: (() => void) | undefined;
    let offDone: (() => void) | undefined;
    let cancelled = false;
    // One coalescer per listener lifetime: SSE text deltas push here and
    // land at most once per animation frame (review 30 — the per-delta
    // setStreaming re-rendered the whole view and re-parsed the accumulated
    // markdown per token). `live` dies with this effect, so a frame pending
    // from an old thread can never write into a new one.
    let live = true;
    const coalescer = new FrameCoalescer((text) => {
      if (!live || !runningRef.current) return; // ended/switched: drop
      streamingRef.current += text;
      setStreaming(streamingRef.current);
    });
    void (async () => {
      // Listeners filter by thread inside the bridge; this view trusts that
      // and accumulates everything it receives.
      offEvents = await listenTurnEvents(threadId, (event) => {
        if (cancelled) return;
        // Events after done/abort belong to no visible turn: a buffered
        // delta here used to resurrect the ghost streaming row (review 30).
        if (!runningRef.current) return;
        switch (event.type) {
          case "text_delta":
            coalescer.push(event.text);
            break;
          case "thinking_delta":
            thinkingRef.current += event.text;
            setThinkingText(thinkingRef.current);
            break;
          case "notice":
            setNotice(event.text);
            break;
          default:
            break;
        }
      });
      offDone = await listenTurnDone(threadId, (done) => {
        if (cancelled) return;
        runningRef.current = false;
        setRunning(false);
        streamingRef.current = "";
        setStreaming("");
        thinkingRef.current = "";
        setThinkingText("");
        if ("error" in done) {
          // The transcript is re-read even on failure: completed work stays
          // (D68), and the error is a row-shaped notice, not a crash.
          setNotice(done.error);
        }
        void refresh();
      });
    })();
    return () => {
      cancelled = true;
      live = false;
      offEvents?.();
      offDone?.();
    };
  }, [threadId, refresh]);

  async function send(text: string): Promise<void> {
    if (runningRef.current) return;
    const selected = useThreadStore.getState().threads[threadId]?.model ?? null;
    if (!selected) {
      setNotice("Select a model first — there is nothing to send this to yet.");
      return;
    }
    setNotice(null);
    streamingRef.current = "";
    setStreaming("");
    thinkingRef.current = "";
    setThinkingText("");
    // Running flips BEFORE the invoke (review 30): two Enter presses before
    // the command resolved used to pass the guard twice and start two turns
    // on one thread. Rollback in catch mirrors answerQuestion.
    runningRef.current = true;
    setRunning(true);
    try {
      await turnStart({
        threadId,
        text,
        provider: selected.provider,
        model: selected.id,
        effort: useThreadStore.getState().threads[threadId]?.effort ?? "medium",
        maxTokens: selected.maxOutput,
      });
    } catch (e) {
      runningRef.current = false;
      setRunning(false);
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function stop(): Promise<void> {
    try {
      await turnStop(threadId);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Answer one question card, then watch the resumed turn. Sets running
   * BEFORE awaiting: the command persists the answer and spawns the
   * continuation, which reports through the channels this view already
   * listens on. A refusal surfaces as the view notice and never starts a
   * turn — the card itself shows the field-level reason and stays usable.
   */
  async function answerQuestion(toolCallId: string, answer: string): Promise<void> {
    const selected = useThreadStore.getState().threads[threadId]?.model ?? null;
    if (!selected) {
      throw new Error("Select a model first — there is nothing to resume with yet.");
    }
    runningRef.current = true;
    setRunning(true);
    setNotice(null);
    try {
      await questionAnswer({
        threadId,
        toolCallId,
        answer,
        provider: selected.provider,
        model: selected.id,
        effort: useThreadStore.getState().threads[threadId]?.effort ?? "medium",
        maxTokens: selected.maxOutput,
      });
    } catch (e) {
      runningRef.current = false;
      setRunning(false);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  function onTranscriptScroll() {
    const el = scrollRef.current;
    if (el === null) return;
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  }

  // Follow new rows and streaming text while stuck; parked readers stay put.
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && stuck) el.scrollTop = el.scrollHeight;
  }, [rows, streaming, stuck]);

  function jumpToLatest() {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    setStuck(true);
  }

  // Compact is intent-only: the turn loop (023) owns dispatch — the same
  // event the palette and the shell hotkey emit (App.tsx).
  function requestCompact() {
    window.dispatchEvent(new CustomEvent("clauro:compact-request"));
  }

  // No attachment pipeline exists yet: the pick is honoured with a notice
  // naming the files, never dropped silently.
  function attach(files: File[]) {
    if (files.length === 0) return;
    const names = files.map((f) => f.name).join(", ");
    setNotice(`Attached ${String(files.length)} file(s): ${names} — sending files is not wired yet.`);
  }

  // Stable hand-off (review 32): TranscriptView and each Row are memoised, so
  // an inline arrow here would defeat both on every ChatView re-render. The
  // ref keeps the latest `answerQuestion` closure (thread state included)
  // while the callback identity stays put.
  const answerRef = useRef(answerQuestion);
  answerRef.current = answerQuestion;
  const onQuestionAnswer = useCallback(
    (toolCallId: string, answer: string): Promise<unknown> => answerRef.current(toolCallId, answer),
    [],
  );

  return (
    <div data-testid="chat-view" className="relative mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
      {notice && (
        <p role="status" className="mt-2 shrink-0 text-xs text-warning">
          {notice}
        </p>
      )}
      {/* The ONLY vertical scroller (UI-GUIDE §3): the transcript grows here,
          never the root. The composer footer below is shrink-0: docked. */}
      <div
        ref={scrollRef}
        data-testid="transcript-scroll"
        onScroll={onTranscriptScroll}
        className="mt-3 min-h-0 flex-1 overflow-y-auto"
      >
        <TranscriptView
          rows={rows}
          streaming={streaming.length > 0 ? streaming : undefined}
          onQuestionAnswer={onQuestionAnswer}
        />
        {thinkingText !== "" && streaming.length === 0 && (
          <div className="mt-2">
            <ThinkingRegion
              block={{
                kind: "thinking",
                text: thinkingText,
                signature: "",
                display: "summary",
              }}
            />
          </div>
        )}
      </div>
      {!stuck && rows.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-40 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-popover px-3 py-1 text-xs text-foreground shadow-lg hover:bg-accent"
        >
          <ArrowDown size={12} strokeWidth={2} />
          Jump to latest
        </button>
      )}
      <div data-testid="composer-footer" className="mt-4 shrink-0">
        {rows.length > 0 && (
          <div
            data-testid="context-bar"
            title={`${String(tokens)} / ${String(contextWindow)} tokens · estimate`}
            className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"
          >
            <span className="shrink-0">Context {String(pct)}% used</span>
            <Progress value={pct} className="h-1 flex-1" />
            <span className="shrink-0">
              {String(tokens)} tokens · estimate
            </span>
            <button
              type="button"
              disabled={running}
              onClick={requestCompact}
              className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              Compact
            </button>
          </div>
        )}
        <Composer
          threadId={threadId}
          memoryOff={false}
          running={running}
          onSend={(text) => {
            void send(text);
          }}
          onStop={() => {
            void stop();
          }}
          onAttach={attach}
          onCompact={requestCompact}
        />
        {/* Stop lives in the composer (send↔stop swap); no second button here. */}
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Clauro runs on your machine. Double-check important answers.
        </p>
      </div>
    </div>
  );
}
