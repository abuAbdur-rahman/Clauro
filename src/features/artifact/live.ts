/**
 * The drawer's production producer (D121): the turn events the shell already
 * receives drive the drawer store, and turn-done fetches the thread's newest
 * artifact into a content store the shell renders as drawer props.
 *
 * Two signals, and they are the whole design:
 * - `block_start` on the `artifact` tool → compiling with no id yet. The
 *   model asked; the id does not exist until the loop generates it. The
 *   drawer must never sit silent through that window.
 * - turn-done → `artifact_latest`. The row is the record: it lands content
 *   and flips live. No row (a call that never committed) clears the spinner
 *   instead of letting it spin forever — a silent drawer is the one outcome
 *   this product does not have.
 *
 * The seams are injected so the logic is testable without a Tauri runtime;
 * `useArtifactProducer` is the production wiring, and ChatView is its caller.
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import {
  artifactLatest,
  listenTurnDone,
  listenTurnEvents,
  type ArtifactLatest,
  type TurnEvent,
} from "../turn/turn";
import { useDrawerStore } from "./store";

export type { ArtifactLatest };

interface ArtifactContentState {
  /** Newest artifact per thread as the shell renders it; null = none. */
  threads: Record<string, ArtifactLatest | null>;
  set: (threadId: string, content: ArtifactLatest | null) => void;
  reset: () => void;
}

export const useArtifactContent = create<ArtifactContentState>()((set) => ({
  threads: {},
  set: (threadId, content) => {
    set((s) => ({ threads: { ...s.threads, [threadId]: content } }));
  },
  reset: () => {
    set({ threads: {} });
  },
}));

export interface ProducerDeps {
  listenEvents: (onEvent: (event: TurnEvent) => void) => Promise<() => void>;
  listenDone: (onDone: () => void) => Promise<() => void>;
  fetchLatest: () => Promise<ArtifactLatest | null>;
  setCompiling: (threadId: string, artifactId: string | null) => void;
  setLive: (threadId: string, artifactId: string, version: number) => void;
  setContent: (threadId: string, content: ArtifactLatest | null) => void;
  clear: (threadId: string) => void;
  /** A failed read, as a typed reason — never swallowed, never fatal. */
  onError: (reason: string) => void;
}

/** Start the producer for one thread. Returns the unsubscribe. */
export async function startArtifactProducer(
  threadId: string,
  deps: ProducerDeps,
): Promise<() => void> {
  const refresh = async (): Promise<void> => {
    try {
      const latest = await deps.fetchLatest();
      if (latest === null) {
        deps.setContent(threadId, null);
        // Nothing on disk: whatever spinner an unresolved call left must not
        // outlive the turn that could have resolved it.
        deps.clear(threadId);
        return;
      }
      deps.setContent(threadId, latest);
      deps.setLive(threadId, latest.artifactId, latest.version);
    } catch (e) {
      // Typed out through the caller's surface: the drawer keeps its last
      // known state and the next turn-done retries.
      deps.onError(e instanceof Error ? e.message : String(e));
    }
  };
  const offEvents = await deps.listenEvents((event) => {
    if (event.type === "block_start" && event.kind === "tool_use" && event.tool_name === "artifact") {
      deps.setCompiling(threadId, null);
    }
  });
  const offDone = await deps.listenDone(() => {
    void refresh();
  });
  // Mount path: a thread reopened with an artifact already stored goes live
  // without a turn having run.
  await refresh();
  return () => {
    offEvents();
    offDone();
  };
}

/**
 * Production wiring for one thread; stops on unmount. `onError` is read
 * through a ref so an inline callback cannot restart the producer every
 * render.
 */
export function useArtifactProducer(threadId: string, onError: (reason: string) => void): void {
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void startArtifactProducer(threadId, {
      listenEvents: (cb) => listenTurnEvents(threadId, cb),
      listenDone: (cb) =>
        listenTurnDone(threadId, () => {
          cb();
        }),
      fetchLatest: () => artifactLatest(threadId),
      setCompiling: (t, id) => {
        useDrawerStore.getState().setCompiling(t, id);
      },
      setLive: (t, id, version) => {
        useDrawerStore.getState().setLive(t, id, version);
      },
      setContent: (t, content) => {
        useArtifactContent.getState().set(t, content);
      },
      clear: (t) => {
        useDrawerStore.getState().clear(t);
      },
      onError: (reason) => {
        if (!cancelled) onErrorRef.current(reason);
      },
    })
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else stop = unsubscribe;
      })
      .catch((e: unknown) => {
        // Listener setup itself failed (no Tauri runtime): say so through the
        // same surface, never crash the shell over it.
        if (!cancelled) onErrorRef.current(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [threadId]);
}
