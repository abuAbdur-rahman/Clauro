// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { newNonce, prepareArtifact } from "./prepare";
import type { WorkerLike } from "./compile";
import { transformJsx } from "./compile.transform";

/**
 * The seam: policy from Rust, compile in a Worker, sanitise for SVG, envelope
 * out. A blank artifact is the failure mode, so every branch here has to end in
 * either a real document or a stated reason — never an empty frame.
 */

const CSP = "default-src 'none'; script-src 'nonce-x'; connect-src 'none'";

const policy = (): Promise<string> => Promise.resolve(CSP);

/** A worker that runs the real transform, so the compiled code is real. */
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

describe("nonce", () => {
  it("is 32 hex characters from the platform CSPRNG, and varies", () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(a);
  });
});

describe("html artifacts", () => {
  it("a static artifact becomes a document with no script of its own", async () => {
    const out = await prepareArtifact({
      source: "<h1 class='text-xl'>hello</h1>",
      mediaType: "text/html",
      fetchPolicy: policy,
    });
    expect(out.kind).toBe("live");
    if (out.kind !== "live") return;
    expect(out.doc).toContain("<h1 class='text-xl'>hello</h1>");
    expect(out.doc).toContain("Content-Security-Policy");
  });

  it("a jsx artifact is compiled into the document", async () => {
    const out = await prepareArtifact({
      source:
        '<div id="app"></div><script type="text/jsx">export default () => h("b", {}, "compiled")</script>',
      mediaType: "text/html",
      fetchPolicy: policy,
      createWorker: worker,
    });
    expect(out.kind).toBe("live");
    if (out.kind !== "live") return;
    expect(out.doc).not.toContain("text/jsx");
    expect(out.doc).toContain("__clauroRun");
    // The compiled call, not the JSX the model wrote.
    expect(out.doc).toContain('h("b"');
  });

  it("a syntax error becomes a stated reason, not an empty frame", async () => {
    const out = await prepareArtifact({
      source: '<script type="text/jsx">export default () => <b></script>',
      mediaType: "text/html",
      fetchPolicy: policy,
      createWorker: worker,
    });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.reason).toMatch(/jsx did not compile/);
  });

  it("a host that returns no policy fails closed", async () => {
    const out = await prepareArtifact({
      source: "<h1>x</h1>",
      mediaType: "text/html",
      fetchPolicy: () => Promise.resolve(""),
    });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.reason).toMatch(/policy/i);
  });
});

describe("svg artifacts", () => {
  it("is sanitised, and never compiled", async () => {
    const createWorker = vi.fn(worker);
    const out = await prepareArtifact({
      source:
        '<svg viewBox="0 0 4 4"><script>alert(1)</script><rect width="4" height="4"/></svg>',
      mediaType: "image/svg+xml",
      fetchPolicy: policy,
      createWorker,
    });
    expect(out.kind).toBe("live");
    if (out.kind !== "live") return;
    expect(out.doc).not.toMatch(/<script>alert/);
    expect(out.doc).toMatch(/viewBox/);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("markup that is not an svg fails with a reason", async () => {
    const out = await prepareArtifact({
      source: "<h1>not svg</h1>",
      mediaType: "image/svg+xml",
      fetchPolicy: policy,
    });
    expect(out.kind).toBe("failed");
  });
});

describe("the document the drawer will render", () => {
  it("carries a policy, a nonce on both scripts, and the nav guard", async () => {
    const out = await prepareArtifact({
      source: '<script type="text/jsx">export default () => h("i")</script>',
      mediaType: "text/html",
      fetchPolicy: policy,
      createWorker: worker,
    });
    if (out.kind !== "live") throw new Error("expected live");
    expect(out.doc).toContain("connect-src &#39;none&#39;");
    expect(out.doc).toContain(`nonce="${out.nonce}"`);
    // The guard is installed by the runtime before the artifact's code runs.
    expect(out.doc.indexOf("addEventListener")).toBeLessThan(out.doc.lastIndexOf("<script"));
  });
});