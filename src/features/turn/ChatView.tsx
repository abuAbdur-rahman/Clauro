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
import { useThreadStore } from "../catalogue/thread";
import { useArtifactProducer } from "../artifact/live";
import { TranscriptView, ThinkingRegion } from "../transcript/TranscriptView";
import type { RenderRow } from "../transcript/types";
import {
  listenTurnDone,
  listenTurnEvents,
  questionAnswer,
  transcriptRead,
  turnStart,
  turnStop,
} from "./turn";

export function ChatView({ threadId }: { threadId: string }): React.JSX.Element {
  const [rows, setRows] = useState<RenderRow[]>([]);
  const [streaming, setStreaming] = useState("");
  const [thinking, setThinking] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const model = useThreadStore((s) => s.threads[threadId]?.model ?? null);
  const effort = useThreadStore((s) => s.threads[threadId]?.effort ?? "medium");
  const streamingRef = useRef("");
  const runningRef = useRef(false);

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
    runningRef.current = false;
    setRunning(false);
    setStreaming("");
    streamingRef.current = "";
    setThinking(false);
    setNotice(null);
    void refresh();
    let offEvents: (() => void) | undefined;
    let offDone: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      // Listeners filter by thread inside the bridge; this view trusts that
      // and accumulates everything it receives.
      offEvents = await listenTurnEvents(threadId, (event) => {
        if (cancelled) return;
        switch (event.type) {
          case "text_delta":
            streamingRef.current += event.text;
            setStreaming(streamingRef.current);
            break;
          case "thinking_delta":
            setThinking(true);
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
        setThinking(false);
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
    setThinking(false);
    try {
      await turnStart({
        threadId,
        text,
        provider: selected.provider,
        model: selected.id,
        effort: useThreadStore.getState().threads[threadId]?.effort ?? "medium",
        maxTokens: selected.maxOutput,
      });
      runningRef.current = true;
      setRunning(true);
    } catch (e) {
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

  return (
    <div data-testid="chat-view" className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
      <p className="mt-1 shrink-0 text-xs text-neutral-500">
        thread {threadId} · model{" "}
        {model ? `${model.provider}/${model.id}` : "none"} · effort {effort}
      </p>
      {notice && (
        <p role="status" className="mt-2 shrink-0 text-xs text-amber-400">
          {notice}
        </p>
      )}
      {/* The ONLY vertical scroller (UI-GUIDE §3): the transcript grows here,
          never the root. */}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        <TranscriptView
          rows={rows}
          streaming={streaming.length > 0 ? streaming : undefined}
          onQuestionAnswer={(toolCallId, answer) => answerQuestion(toolCallId, answer)}
        />
        {thinking && streaming.length === 0 && (
          <div className="mt-2">
            <ThinkingRegion
              block={{ kind: "thinking", text: "Thinking…", signature: "", display: "summary" }}
            />
          </div>
        )}
      </div>
      <div className="mt-4 shrink-0">
        <Composer
          threadId={threadId}
          memoryOff={false}
          onSend={(text) => {
            void send(text);
          }}
        />
        {running && (
          <div className="mt-2 flex justify-center">
            <button
              type="button"
              onClick={() => {
                void stop();
              }}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              Stop
            </button>
          </div>
        )}
        <p className="mt-2 text-center text-xs text-neutral-500">
          Clauro runs on your machine. Double-check important answers.
        </p>
      </div>
    </div>
  );
}
