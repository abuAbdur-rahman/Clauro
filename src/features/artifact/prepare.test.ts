// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { newNonce, prepareArtifact } from "./prepare";
import type { WorkerLike } from "./compile";
import { transformJsx } from "./compile.transform";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/**
 * The seam: policy from Rust, compile in a Worker, sanitise for SVG, envelope
 * out, publish to the host (D123). A blank artifact is the failure mode, so
 * every branch here has to end in a URL the frame can load or a stated reason
 * — never an empty frame, and never a publish for a prepare that failed.
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

/**
 * Stands in for `artifact_publish` (D123): records the bytes Rust would store
 * and answers with the URL the frame loads. The result carries only the URL —
 * the document belongs to the host now — so tests assert on what was
 * published, which is what the frame will actually render.
 */
function publisher() {
  const published: { nonce: string; doc: string }[] = [];
  const publishDoc = (nonce: string, doc: string): Promise<string> => {
    published.push({ nonce, doc });
    return Promise.resolve(`http://artifact.localhost/__clauro/doc/${nonce}`);
  };
  return { published, publishDoc };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("nonce", () => {
  it("is 32 hex characters from the platform CSPRNG, and varies", () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(a);
  });
});

describe("html artifacts", () => {
  it("a static artifact becomes a document with no script of its own", async () => {
    const pub = publisher();
    const out = await prepareArtifact({
      source: "<h1 class='text-xl'>hello</h1>",
      mediaType: "text/html",
      fetchPolicy: policy,
      publishDoc: pub.publishDoc,
    });
    expect(out.kind).toBe("live");
    if (out.kind !== "live") return;
    expect(pub.published).toHaveLength(1);
    const doc = pub.published[0]?.doc ?? "";
    expect(doc).toContain("<h1 class='text-xl'>hello</h1>");
    expect(doc).toContain("Content-Security-Policy");
    // The frame gets the host's URL for this render's own document (D123).
    expect(pub.published[0]?.nonce).toBe(out.nonce);
    expect(out.url).toBe(`http://artifact.localhost/__clauro/doc/${out.nonce}`);
  });

  it("a jsx artifact is compiled into the document", async () => {
    const pub = publisher();
    const out = await prepareArtifact({
      source:
        '<div id="app"></div><script type="text/jsx">export default () => h("b", {}, "compiled")</script>',
      mediaType: "text/html",
      fetchPolicy: policy,
      createWorker: worker,
      publishDoc: pub.publishDoc,
    });
    expect(out.kind).toBe("live");
    if (out.kind !== "live") return;
    expect(pub.published).toHaveLength(1);
    const doc = pub.published[0]?.doc ?? "";
    expect(doc).not.toContain("text/jsx");
    expect(doc).toContain("__clauroRun");
    // The compiled call, not the JSX the model wrote.
    expect(doc).toContain('h("b"');
  });

  it("a syntax error becomes a stated reason, not an empty frame", async () => {
    const pub = publisher();
    const out = await prepareArtifact({
      source: '<script type="text/jsx">export default () => <b></script>',
      mediaType: "text/html",
      fetchPolicy: policy,
      createWorker: worker,
      publishDoc: pub.publishDoc,
    });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.reason).toMatch(/jsx did not compile/);
    // A prepare that failed never hands Rust a document to serve.
    expect(pub.published).toHaveLength(0);
  });

  it("a host that returns no policy fails closed", async () => {
    const pub = publisher();
    const out = await prepareArtifact({
      source: "<h1>x</h1>",
      mediaType: "text/html",
      fetchPolicy: () => Promise.resolve(""),
      publishDoc: pub.publishDoc,
    });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.reason).toMatch(/policy/i);
    expect(pub.published).toHaveLength(0);
  });
});

describe("svg artifacts", () => {
  it("is sanitised, and never compiled", async () => {
    const createWorker = vi.fn(worker);
    const pub = publisher();
    const out = await prepareArtifact({
      source:
        '<svg viewBox="0 0 4 4"><script>alert(1)</script><rect width="4" height="4"/></svg>',
      mediaType: "image/svg+xml",
      fetchPolicy: policy,
      createWorker,
      publishDoc: pub.publishDoc,
    });
    expect(out.kind).toBe("live");
    if (out.kind !== "live") return;
    expect(pub.published).toHaveLength(1);
    const doc = pub.published[0]?.doc ?? "";
    expect(doc).not.toMatch(/<script>alert/);
    expect(doc).toMatch(/viewBox/);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("markup that is not an svg fails with a reason", async () => {
    const pub = publisher();
    const out = await prepareArtifact({
      source: "<h1>not svg</h1>",
      mediaType: "image/svg+xml",
      fetchPolicy: policy,
      publishDoc: pub.publishDoc,
    });
    expect(out.kind).toBe("failed");
    expect(pub.published).toHaveLength(0);
  });
});

describe("the document the host publishes for the drawer", () => {
  it("carries a policy, a nonce on both scripts, and the nav guard", async () => {
    const pub = publisher();
    const out = await prepareArtifact({
      source: '<script type="text/jsx">export default () => h("i")</script>',
      mediaType: "text/html",
      fetchPolicy: policy,
      createWorker: worker,
      publishDoc: pub.publishDoc,
    });
    if (out.kind !== "live") throw new Error("expected live");
    expect(pub.published).toHaveLength(1);
    const doc = pub.published[0]?.doc ?? "";
    expect(doc).toContain("connect-src &#39;none&#39;");
    expect(doc).toContain(`nonce="${out.nonce}"`);
    // The guard is installed by the runtime before the artifact's code runs.
    expect(doc.indexOf("addEventListener")).toBeLessThan(doc.lastIndexOf("<script"));
  });
});

describe("publishing to the host (D123)", () => {
  it("the default publisher hands the document to artifact_publish and adopts its URL", async () => {
    // The host is remote by construction (D124): the adopted URL must never
    // name the shell's host, or the frame would read as local to Tauri's IPC.
    vi.mocked(invoke).mockResolvedValue("http://artifact.localhost/__clauro/doc/from-host");
    const out = await prepareArtifact({
      source: "<h1>x</h1>",
      mediaType: "text/html",
      fetchPolicy: policy,
    });
    const calls = vi.mocked(invoke).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("artifact_publish");
    // The nonce Rust will rebuild the header from is the one that went in,
    // and the document is the one the frame will load (D123). InvokeArgs is a
    // union down to ArrayBuffer, so narrow before reading it as an object.
    const args = calls[0]?.[1];
    if (
      args === undefined ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      ArrayBuffer.isView(args) ||
      args instanceof ArrayBuffer
    ) {
      throw new Error(`unexpected artifact_publish args: ${JSON.stringify(args)}`);
    }
    expect(String(args.nonce)).toMatch(/^[0-9a-f]{32}$/);
    expect(String(args.doc)).toContain("<h1>x</h1>");
    if (out.kind !== "live") throw new Error(`expected live, got ${JSON.stringify(out)}`);
    expect(out.url).toBe("http://artifact.localhost/__clauro/doc/from-host");
  });

  it("a host that refuses to publish fails closed with the reason", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("bad artifact document token"));
    const out = await prepareArtifact({
      source: "<h1>x</h1>",
      mediaType: "text/html",
      fetchPolicy: policy,
    });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toMatch(/could not publish the artifact document/);
    expect(out.reason).toContain("bad artifact document token");
  });

  it("a host that answers with a non-string fails closed", async () => {
    vi.mocked(invoke).mockResolvedValue(42);
    const out = await prepareArtifact({
      source: "<h1>x</h1>",
      mediaType: "text/html",
      fetchPolicy: policy,
    });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toMatch(/could not publish the artifact document/);
  });

  it("a publisher that throws fails closed with the reason", async () => {
    const out = await prepareArtifact({
      source: "<h1>x</h1>",
      mediaType: "text/html",
      fetchPolicy: policy,
      publishDoc: () => Promise.reject(new Error("registry poisoned")),
    });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toBe(
      "could not publish the artifact document: registry poisoned",
    );
  });

  it("an empty URL from the host fails closed — no frame without a document", async () => {
    const out = await prepareArtifact({
      source: "<h1>x</h1>",
      mediaType: "text/html",
      fetchPolicy: policy,
      publishDoc: () => Promise.resolve("   "),
    });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") return;
    expect(out.reason).toMatch(/no artifact document URL/i);
  });
});
