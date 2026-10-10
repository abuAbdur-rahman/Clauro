/**
 * The drawer's production producer (D121), seam-tested: turn events flip the
 * drawer to compiling the moment the model asks for an artifact, and
 * turn-done fetches the thread's newest row into the content store the shell
 * renders. Deps are injected, so what is pinned here is the logic — the wire
 * (real listeners + `artifact_latest`) is glued in `useArtifactProducer` and
 * proven through ChatView's own test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  startArtifactProducer,
  useArtifactContent,
  type ArtifactLatest,
  type ProducerDeps,
} from "./live";
import { useDrawerStore } from "./store";
import type { TurnEvent } from "../turn/turn";

const THREAD = "t-live";

const DOC: ArtifactLatest = {
  artifactId: "a9",
  version: 2,
  title: "Demo",
  mediaType: "text/html",
  source: "<h1>x</h1>",
};

type EventCb = (event: TurnEvent) => void;

interface Harness {
  deps: ProducerDeps;
  compiling: Array<[string, string | null]>;
  live: Array<[string, string, number]>;
  content: Array<[string, ArtifactLatest | null]>;
  cleared: string[];
  errors: string[];
  fire: { event: (e: TurnEvent) => void; done: () => void };
  unlistened: { events: number; done: number };
}

function makeDeps(over: Partial<ProducerDeps> = {}): Harness {
  const h: Harness = {
    deps: {} as ProducerDeps,
    compiling: [],
    live: [],
    content: [],
    cleared: [],
    errors: [],
    unlistened: { events: 0, done: 0 },
    fire: { event: () => undefined, done: () => undefined },
  };
  let onEvent: EventCb | null = null;
  let onDone: (() => void) | null = null;
  h.deps = {
    listenEvents: vi.fn((cb: EventCb) => {
      onEvent = cb;
      return Promise.resolve(() => {
        h.unlistened.events += 1;
        onEvent = null;
      });
    }),
    listenDone: vi.fn((cb: () => void) => {
      onDone = cb;
      return Promise.resolve(() => {
        h.unlistened.done += 1;
        onDone = null;
      });
    }),
    fetchLatest: vi.fn((): Promise<ArtifactLatest | null> => Promise.resolve(null)),
    setCompiling: vi.fn((threadId: string, artifactId: string | null) => {
      h.compiling.push([threadId, artifactId]);
    }),
    setLive: vi.fn((threadId: string, artifactId: string, version: number) => {
      h.live.push([threadId, artifactId, version]);
    }),
    setContent: vi.fn((threadId: string, content: ArtifactLatest | null) => {
      h.content.push([threadId, content]);
    }),
    clear: vi.fn((threadId: string) => {
      h.cleared.push(threadId);
    }),
    onError: vi.fn((reason: string) => {
      h.errors.push(reason);
    }),
    ...over,
  };
  h.fire = {
    event: (e) => onEvent?.(e),
    done: () => onDone?.(),
  };
  return h;
}

/** Let the handler's fire-and-forget refresh settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useDrawerStore.getState().reset();
  useArtifactContent.getState().reset();
});

describe("startArtifactProducer (D121)", () => {
  it("an artifact dispatch flips the drawer to compiling with no id yet", async () => {
    const h = makeDeps();
    await startArtifactProducer(THREAD, h.deps);
    h.fire.event({
      type: "block_start",
      index: 1,
      kind: "tool_use",
      tool_id: "call-1",
      tool_name: "artifact",
    });
    expect(h.compiling).toEqual([[THREAD, null]]);
    // Other tools and other blocks are not the drawer's business.
    h.fire.event({
      type: "block_start",
      index: 2,
      kind: "tool_use",
      tool_id: "call-2",
      tool_name: "fs",
    });
    h.fire.event({ type: "block_start", index: 3, kind: "text" });
    h.fire.event({ type: "text_delta", index: 3, text: "hi" });
    expect(h.compiling).toEqual([[THREAD, null]]);
  });

  it("start restores a live artifact from the store (mount path)", async () => {
    const h = makeDeps({ fetchLatest: vi.fn(() => Promise.resolve(DOC)) });
    await startArtifactProducer(THREAD, h.deps);
    expect(h.content).toEqual([[THREAD, DOC]]);
    expect(h.live).toEqual([[THREAD, "a9", 2]]);
    expect(h.compiling).toHaveLength(0);
  });

  it("turn-done refetches the newest row and goes live", async () => {
    const h = makeDeps({ fetchLatest: vi.fn(() => Promise.resolve(DOC)) });
    await startArtifactProducer(THREAD, h.deps);
    h.content.length = 0;
    h.live.length = 0;
    h.fire.done();
    await flush();
    expect(h.content).toEqual([[THREAD, DOC]]);
    expect(h.live).toEqual([[THREAD, "a9", 2]]);
  });

  it("a thread with no artifacts clears the spinner instead of spinning", async () => {
    const h = makeDeps(); // fetch resolves null throughout
    await startArtifactProducer(THREAD, h.deps);
    h.fire.event({
      type: "block_start",
      index: 1,
      kind: "tool_use",
      tool_id: "call-1",
      tool_name: "artifact",
    });
    expect(h.compiling).toEqual([[THREAD, null]]);
    h.fire.done();
    await flush();
    expect(h.cleared).toContain(THREAD);
    expect(h.content).toContainEqual([THREAD, null]);
    expect(h.live).toHaveLength(0);
  });

  it("a failed read surfaces a typed reason and leaves the drawer alone", async () => {
    const h = makeDeps({
      fetchLatest: vi.fn(() => Promise.reject(new Error("store unreadable"))),
    });
    await startArtifactProducer(THREAD, h.deps);
    expect(h.errors).toEqual(["store unreadable"]);
    expect(h.live).toHaveLength(0);
    h.fire.done();
    await flush();
    expect(h.errors).toEqual(["store unreadable", "store unreadable"]);
  });

  it("cleanup unsubscribes both channels", async () => {
    const h = makeDeps();
    const stop = await startArtifactProducer(THREAD, h.deps);
    stop();
    expect(h.unlistened).toEqual({ events: 1, done: 1 });
    h.fire.event({
      type: "block_start",
      index: 1,
      kind: "tool_use",
      tool_id: "call-1",
      tool_name: "artifact",
    });
    h.fire.done();
    await flush();
    expect(h.compiling).toHaveLength(0);
  });
});

describe("artifact content store", () => {
  it("holds one document per thread and resets", () => {
    useArtifactContent.getState().set(THREAD, DOC);
    expect(useArtifactContent.getState().threads[THREAD]).toEqual(DOC);
    useArtifactContent.getState().set("t-other", null);
    expect(useArtifactContent.getState().threads["t-other"]).toBeNull();
    expect(useArtifactContent.getState().threads[THREAD]).toEqual(DOC);
    useArtifactContent.getState().reset();
    expect(useArtifactContent.getState().threads).toEqual({});
  });
});
