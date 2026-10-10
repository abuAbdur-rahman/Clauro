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
 * REAL `prepareArtifact` — injected policy, publisher and worker only, because
 * jsdom has neither Tauri nor a `Worker`. The last-inch driver here is
 * test-local and labelled as such: the production producer landed with D121
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
 * Stands in for `artifact_publish` (D123): jsdom has no Tauri, so the e2e
 * injects the publisher the same way it injects the policy. The captured docs
 * are what Rust would serve, so asserting on them asserts on the frame's
 * bytes; the URL is what the frame actually navigates to.
 */
function publisher() {
  const published: { nonce: string; doc: string }[] = [];
  const publishDoc = (nonce: string, doc: string): Promise<string> => {
    published.push({ nonce, doc });
    return Promise.resolve(`http://artifact.localhost/__clauro/doc/${nonce}`);
  };
  return { published, publishDoc };
}

/**
 * The test-local driver (D113): a stand-in for the production producer
 * (`features/artifact/live.ts`, D121) at the composition boundary. What a
 * tool-result handler does once a host drives turns — now also done for real.
 */
function onArtifactToolResult(input: { artifactId: string; version: number }) {
  // Every result kicks a fresh prepare; the drawer prepares while `compiling`.
  useDrawerStore.getState().setCompiling(THREAD, input.artifactId);
}

function draw(
  source: string,
  mediaType = "text/html",
  title = "Demo",
  publishDoc?: (nonce: string, doc: string) => Promise<string>,
) {
  return render(
    <ArtifactDrawer
      threadId={THREAD}
      engine={ENGINE}
      source={source}
      mediaType={mediaType}
      title={title}
      fetchPolicy={policy}
      createWorker={worker}
      publishDoc={publishDoc}
    />,
  );
}

beforeEach(() => {
  cleanup();
  useDrawerStore.getState().reset();
});

describe("phase 3 gate e2e: tool result renders live", () => {
  it("a tool result for artifact ends in a live, sandboxed frame", async () => {
    const pub = publisher();
    onArtifactToolResult({ artifactId: "a1", version: 1 });
    draw("<h1 class='text-xl'>hello e2e</h1>", "text/html", "Demo", pub.publishDoc);

    const frame = await screen.findByTitle("artifact-frame");
    // Host-fixed sandbox (D108): exactly `allow-scripts`, never widened.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    // D123: the frame navigates to the published URL, never an inline document.
    expect(pub.published).toHaveLength(1);
    expect(frame.getAttribute("src")).toBe(
      `http://artifact.localhost/__clauro/doc/${pub.published[0]?.nonce ?? ""}`,
    );
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    const doc = pub.published[0]?.doc ?? "";
    expect(doc).toContain("hello e2e");
    // The Rust-shaped policy survived to the document (D3).
    expect(doc).toContain("connect-src");
    expect(screen.getByText("Demo")).not.toBeNull();
  });

  it("a refresh prepares again and renders the new bytes", async () => {
    const pub = publisher();
    onArtifactToolResult({ artifactId: "a9", version: 1 });
    const view = draw("<p>v1 body</p>", "text/html", "Demo", pub.publishDoc);
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
        publishDoc={pub.publishDoc}
      />,
    );
    await waitFor(() => {
      expect(pub.published).toHaveLength(2);
      const doc = pub.published[1]?.doc ?? "";
      expect(doc).toContain("v2 body");
      const frame = screen.getByTitle("artifact-frame");
      expect(frame.getAttribute("src")).toBe(
        `http://artifact.localhost/__clauro/doc/${pub.published[1]?.nonce ?? ""}`,
      );
    });
  });

  it("a failed prepare shows the reason, never a blank frame", async () => {
    const pub = publisher();
    onArtifactToolResult({ artifactId: "bad", version: 1 });
    draw('<script type="text/jsx">export default () => <b></script>', "text/html", "Broken", pub.publishDoc);

    expect(await screen.findByText(/did not compile/)).not.toBeNull();
    expect(screen.queryByTitle("artifact-frame")).toBeNull();
    // A failed prepare publishes nothing: Rust has no bytes to serve.
    expect(pub.published).toHaveLength(0);
  });
});
