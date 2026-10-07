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
import { TranscriptView } from "../transcript/TranscriptView";
import type { RenderRow } from "../transcript/types";
import {
  listenTurnDone,
  listenTurnEvents,
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

  return (
    <div data-testid="chat-view">
      <p className="mt-1 text-xs text-neutral-500">
        thread {threadId} · model{" "}
        {model ? `${model.provider}/${model.id}` : "none"} · effort {effort}
      </p>
      {notice && (
        <p role="status" className="mt-2 text-xs text-amber-400">
          {notice}
        </p>
      )}
      <div className="mt-3">
        <TranscriptView
          rows={rows}
          streaming={streaming.length > 0 ? streaming : undefined}
        />
        {thinking && streaming.length === 0 && (
          <p className="mt-2 text-xs text-neutral-500">Thinking…</p>
        )}
      </div>
      <div className="mt-4 max-w-2xl">
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
