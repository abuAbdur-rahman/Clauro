/**
 * Turning one artifact tool call into a document the frame can render.
 *
 * This is the seam between the parts: policy from Rust, markup from the tool,
 * compile in a Worker, sanitise for SVG, envelope out, then publish the
 * finished document to the host and navigate the frame to the URL it answers
 * with (D123). Every failure is a typed outcome the drawer renders — the
 * drawer's three states are empty, compiling, live, and a fourth case
 * (`failed`) that shows the reason instead of an empty frame. A blank artifact
 * is the bug this module exists to prevent, so it never returns a
 * partially-built document and never reports `live` without a URL Rust
 * accepted.
 */
import { invoke } from "@tauri-apps/api/core";
import { compileBlocks, extractJsxBlocks, type WorkerLike } from "./compile";
import { buildEnvelope } from "./envelope";
import { sanitizeSvg } from "./sanitize";
import { artifactGate, setRenderNonce, type EngineGate } from "./store";

export type PrepareResult =
  | { kind: "live"; url: string; nonce: string }
  | { kind: "failed"; reason: string };

export interface PrepareInput {
  source: string;
  mediaType: string;
  /** Every seam below is optional AND may be passed as an explicit
   *  `undefined` by callers that hold `fn | undefined` — exactOptionalPropertyTypes
   *  requires the `| undefined` to say so. */
  fetchPolicy?: ((nonce: string) => Promise<string>) | undefined;
  /** Injected in tests; the shell calls `artifact_publish` in Rust (D123). */
  publishDoc?: ((nonce: string, doc: string) => Promise<string>) | undefined;
  createWorker?: (() => WorkerLike) | undefined;
  /** Defaults to the detected engine; pass it in tests to drive the D45 gate. */
  engine?: EngineGate | undefined;
}

/**
 * Input bound (D27: output is bounded on the way out — and input this size
 * never reaches the out-path at all). Measured in UTF-8 bytes, because the
 * document that follows is bytes.
 */
export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The document host's own URL (D123): `artifact_doc.rs::doc_url` answers with
 * `{ORIGIN}/__clauro/doc/{nonce}` — `http://artifact.localhost` where that
 * origin is registered, `artifact://localhost` where the Linux handler
 * registers the scheme instead. This string becomes the frame's `src`, so
 * anything else would render outside the Rust-assembled policy. If a
 * serve-token ever lands in the path or query, this pattern must move in the
 * same change as `artifact_doc.rs`.
 */
const DOCUMENT_URL =
  /^(?:http:\/\/artifact\.localhost|artifact:\/\/localhost)\/__clauro\/doc\/[A-Za-z0-9_-]{1,128}(?:\?[A-Za-z0-9_=&%.-]*)?$/;

/** Strip `<meta http-equiv="refresh">` tags: a smuggled refresh navigates the
 * frame away from the document this host built (audit 14). Quotes are
 * honoured so a `>` inside an attribute value cannot hide the tag. */
function stripMetaRefresh(markup: string): string {
  const META = /<meta\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
  return markup.replace(META, (tag) =>
    /http-equiv/i.test(tag) && /\brefresh\b/i.test(tag) ? "" : tag,
  );
}

/** A nonce per render, from the platform CSPRNG. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The real Worker factory: Sucrase in its own thread, per D4. */
export function createCompileWorker(): WorkerLike {
  return new Worker(new URL("./compile.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

async function defaultPolicy(nonce: string): Promise<string> {
  const raw: unknown = await invoke("artifact_csp", { nonce });
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("the host returned no artifact policy");
  }
  return raw;
}

/**
 * Rust stores the bytes and answers with the URL the frame navigates to
 * (D123). The type check is here because `invoke` is `unknown` on the way
 * back: a non-string is a broken contract, not a document.
 */
async function defaultPublish(nonce: string, doc: string): Promise<string> {
  const raw: unknown = await invoke("artifact_publish", { nonce, doc });
  if (typeof raw !== "string") {
    throw new Error("the host returned a non-text artifact document URL");
  }
  return raw;
}

export async function prepareArtifact(input: PrepareInput): Promise<PrepareResult> {
  // The D45 gate, checked before anything is fetched or built (audit 14: it
  // used to exist only as a prop the drawer never disagreed with). A disabled
  // engine produces no policy request, no publish, no document.
  const verdict = artifactGate();
  if (!verdict.enabled) {
    return { kind: "failed", reason: verdict.notice ?? "artifacts are disabled on this engine (D45)" };
  }

  const sourceBytes = new TextEncoder().encode(input.source).length;
  if (sourceBytes > SOURCE_MAX_BYTES) {
    return {
      kind: "failed",
      reason: `artifact source is ${String(sourceBytes)} bytes, over the ${String(SOURCE_MAX_BYTES)}-byte cap (D27): split the artifact`,
    };
  }

  const fetchPolicy = input.fetchPolicy ?? defaultPolicy;
  const publishDoc = input.publishDoc ?? defaultPublish;
  const nonce = newNonce();
  // The media type arrives with parameters (`image/svg+xml; charset=utf-8`);
  // the type itself is what selects the path (audit 14).
  const mediaType = input.mediaType.split(";")[0].trim().toLowerCase();
  let csp: string;
  try {
    csp = await fetchPolicy(nonce);
  } catch (e) {
    // No policy means no frame. Failing closed here is the whole reason the
    // policy comes from Rust: a front end that cannot ask cannot render.
    return {
      kind: "failed",
      reason: `could not obtain the artifact policy: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  const { markup, blocks } =
    mediaType === "image/svg+xml" ? { markup: "", blocks: [] } : extractJsxBlocks(input.source);

  let body = markup;
  let code = "";
  if (mediaType === "image/svg+xml") {
    const clean = await sanitizeSvg(input.source);
    if (clean.kind === "error") return { kind: "failed", reason: clean.message };
    body = clean.svg;
  } else if (blocks.length > 0) {
    const compiled = await compileBlocks(blocks, {
      createWorker: input.createWorker ?? createCompileWorker,
    });
    if (compiled.kind === "timeout") {
      return {
        kind: "failed",
        reason:
          "compiling this artifact took too long and was stopped (D4). " +
          "Infinite loops in a <script type=\"text/jsx\"> block are the usual cause.",
      };
    }
    if (compiled.kind === "too-big") return { kind: "failed", reason: compiled.message };
    if (compiled.kind === "error") {
      return { kind: "failed", reason: `jsx did not compile: ${compiled.message}` };
    }
    code = compiled.blocks.join("\n");
  }

  let doc: string;
  try {
    doc = buildEnvelope({
      csp,
      nonce,
      title: "",
      markup: stripMetaRefresh(body),
      code,
      // Empty until `022` vendors the full Tailwind build (D111).
      css: "",
    });
  } catch (e) {
    return {
      kind: "failed",
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  // Publish last: the host has the bytes only once the document is whole, so
  // a prepare that failed earlier never leaves Rust serving a partial frame
  // (D123). A refusal — bad token, empty doc, a registry that threw — is a
  // stated reason, never a `live` result pointing at a URL that will 404.
  let url: string;
  try {
    url = await publishDoc(nonce, doc);
  } catch (e) {
    return {
      kind: "failed",
      reason: `could not publish the artifact document: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  if (url.trim() === "") {
    return { kind: "failed", reason: "the host returned no artifact document URL" };
  }
  if (!DOCUMENT_URL.test(url.trim())) {
    return {
      kind: "failed",
      reason: `the host returned a URL outside the document host: ${url}`,
    };
  }
  // The handshake secret for this render (D6): channel.ts refuses a hello
  // that does not name this document.
  setRenderNonce(nonce);
  return { kind: "live", url, nonce };
}