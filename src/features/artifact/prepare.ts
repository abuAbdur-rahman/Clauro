/**
 * Turning one artifact tool call into a document the frame can render.
 *
 * This is the seam between the parts: policy from Rust, markup from the tool,
 * compile in a Worker, sanitise for SVG, envelope out. Every failure is a typed
 * outcome the drawer renders — the drawer's three states are empty,
 * compiling, live, and a fourth case (`failed`) that shows the reason instead
 * of an empty frame. A blank artifact is the bug this module exists to prevent,
 * so it never returns a partially-built document.
 */
import { invoke } from "@tauri-apps/api/core";
import { compileBlocks, extractJsxBlocks, type WorkerLike } from "./compile";
import { buildEnvelope } from "./envelope";
import { sanitizeSvg } from "./sanitize";

export type PrepareResult =
  | { kind: "live"; doc: string; nonce: string }
  | { kind: "failed"; reason: string };

export interface PrepareInput {
  source: string;
  mediaType: string;
  /** Injected in tests; the shell calls `artifact_csp` in Rust. */
  fetchPolicy?: (nonce: string) => Promise<string>;
  createWorker?: () => WorkerLike;
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

export async function prepareArtifact(input: PrepareInput): Promise<PrepareResult> {
  const fetchPolicy = input.fetchPolicy ?? defaultPolicy;
  const nonce = newNonce();
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
    input.mediaType === "image/svg+xml"
      ? { markup: "", blocks: [] }
      : extractJsxBlocks(input.source);

  let body = markup;
  let code = "";
  if (input.mediaType === "image/svg+xml") {
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

  try {
    const doc = buildEnvelope({
      csp,
      nonce,
      title: "",
      markup: body,
      code,
      // Empty until `022` vendors the full Tailwind build (D111).
      css: "",
    });
    return { kind: "live", doc, nonce };
  } catch (e) {
    return {
      kind: "failed",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}