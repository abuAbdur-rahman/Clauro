// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ArtifactDrawer } from "../../components/ArtifactDrawer";
import { useDrawerStore } from "./store";
import type { WorkerLike } from "./compile";
import { transformJsx } from "./compile.transform";

/**
 * Phase 3 gate e2e, frontend half (`Tasks/028`, D113): a tool result for
 * `artifact` renders live in the drawer through the REAL store actions and the
 * REAL `prepareArtifact` — injected policy + worker only, because jsdom has
 * neither Tauri nor a `Worker`. The last-inch driver here is test-local and
 * labelled as such: the production producer landed with D121
 * (`features/artifact/live.ts`), and this file keeps proving the composition
 * it drives — real store, real prepare — under test.
 */

const THREAD = "t1";
const ENGINE = { platform: "windows" as const, opaqueProven: true };
// Shaped like the Rust-assembled policy (`src-tauri/src/csp.rs`): the value
// comes from Rust in production and is injected here.
const CSP = "default-src 'none'; script-src 'nonce-x'; connect-src 'none'";

/** A worker that runs the real transform, so compiled code is real. */
function worker(): WorkerLike {
  const w: WorkerLike = {
    postMessage: () => undefined,
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  };
  w.postMessage = (message: unknown) => {
    const source = (message as { source: string }).source;
    queueMicrotask(() => {
      const out = transformJsx(source);
      if (out.kind === "error") w.onerror?.({ message: out.message });
      else w.onmessage?.({ data: { kind: "ok", code: out.code } });
    });
  };
  return w;
}

const policy = (): Promise<string> => Promise.resolve(CSP);

/**
 * The test-local driver (D113): a stand-in for the production producer
 * (`features/artifact/live.ts`, D121) at the composition boundary. What a
 * tool-result handler does once a host drives turns — now also done for real.
 */
function onArtifactToolResult(input: { artifactId: string; version: number }) {
  // Every result kicks a fresh prepare; the drawer prepares while `compiling`.
  useDrawerStore.getState().setCompiling(THREAD, input.artifactId);
}

function draw(source: string, mediaType = "text/html", title = "Demo") {
  return render(
    <ArtifactDrawer
      threadId={THREAD}
      engine={ENGINE}
      source={source}
      mediaType={mediaType}
      title={title}
      fetchPolicy={policy}
      createWorker={worker}
    />,
  );
}

beforeEach(() => {
  cleanup();
  useDrawerStore.getState().reset();
});

describe("phase 3 gate e2e: tool result renders live", () => {
  it("a tool result for artifact ends in a live, sandboxed frame", async () => {
    onArtifactToolResult({ artifactId: "a1", version: 1 });
    draw("<h1 class='text-xl'>hello e2e</h1>");

    const frame = await screen.findByTitle("artifact-frame");
    // Host-fixed sandbox (D108): exactly `allow-scripts`, never widened.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const doc = frame.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("hello e2e");
    // The Rust-shaped policy survived to the document (D3).
    expect(doc).toContain("connect-src");
    expect(screen.getByText("Demo")).not.toBeNull();
  });

  it("a refresh prepares again and renders the new bytes", async () => {
    onArtifactToolResult({ artifactId: "a9", version: 1 });
    const view = draw("<p>v1 body</p>");
    await screen.findByTitle("artifact-frame");

    // Second tool result, same artifact: the producer kicks a new prepare and
    // the drawer renders the new source, not the old document.
    onArtifactToolResult({ artifactId: "a9", version: 2 });
    view.rerender(
      <ArtifactDrawer
        threadId={THREAD}
        engine={ENGINE}
        source="<p>v2 body</p>"
        mediaType="text/html"
        title="Demo"
        fetchPolicy={policy}
        createWorker={worker}
      />,
    );
    await waitFor(() => {
      const frame = screen.getByTitle("artifact-frame");
      expect(frame.getAttribute("srcdoc")).toContain("v2 body");
    });
  });

  it("a failed prepare shows the reason, never a blank frame", async () => {
    onArtifactToolResult({ artifactId: "bad", version: 1 });
    draw('<script type="text/jsx">export default () => <b></script>', "text/html", "Broken");

    expect(await screen.findByText(/did not compile/)).not.toBeNull();
    expect(screen.queryByTitle("artifact-frame")).toBeNull();
  });
});
