/**
 * The host half of the compile boundary: block extraction, the timeout, the
 * output cap (D4, SPEC A6).
 *
 * Three failures are load-bearing and each has its own test: a worker that
 * never answers times out, output over the cap is refused, and a syntax error
 * comes back as a value. None of them may throw across this boundary — a
 * rejected promise here would be an unhandled rejection in the shell's render
 * path.
 *
 * **This module does not import Sucrase.** The transform lives in
 * `compile.transform.ts`, which only `compile.worker.ts` reaches. That is not
 * tidiness: a static import here would put Sucrase in the main chunk and make
 * host-side compiling *possible*, and D4 says the compile happens in a Worker
 * behind a timeout and a cap. A test asserts the import graph, so "Sucrase is
 * unreachable from the host" is a checked property.
 *
 * Nothing is imported from the DOM except through the injected worker factory,
 * so the same code compiles and runs headless.
 */

/** Output cap, in bytes. An artifact that transforms to more is refused. */
export const COMPILED_MAX_BYTES = 1024 * 1024;

/** Wall-clock budget for one block. Sucrase is milliseconds; this is the
 * "infinite loop in artifact code" case, which the *frame* contains, not the
 * compile. The worker's own timeout exists for a wedged worker. */
export const COMPILE_TIMEOUT_MS = 3000;

const BLOCK_OPEN = '<script type="text/jsx">';
const BLOCK_CLOSE = "</script>";

export type CompileOutcome =
  | { kind: "ok"; blocks: string[] }
  | { kind: "timeout" }
  | { kind: "too-big"; message: string }
  | { kind: "error"; message: string };

/** The slice of `Worker` this module needs, so a test can drive it. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  /**
   * `this: void` so a test stand-in's spy can be inspected without binding — the
   * rule that forbids separating a method exists to stop an unbound `this`, and
   * a stand-in's spy has none to lose.
   */
  terminate: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

/**
 * Split an artifact into the markup that stays literal and the JSX blocks that
 * need compiling. An unterminated block is left as markup rather than silently
 * swallowing the rest of the document.
 */
export function extractJsxBlocks(source: string): {
  markup: string;
  blocks: string[];
} {
  const blocks: string[] = [];
  let markup = "";
  let cursor = 0;
  for (;;) {
    const start = source.indexOf(BLOCK_OPEN, cursor);
    if (start < 0) break;
    const bodyStart = start + BLOCK_OPEN.length;
    const end = source.indexOf(BLOCK_CLOSE, bodyStart);
    if (end < 0) break;
    blocks.push(source.slice(bodyStart, end));
    markup += `${source.slice(cursor, start)}<!--jsx:${String(blocks.length - 1)}-->`;
    cursor = end + BLOCK_CLOSE.length;
  }
  markup += source.slice(cursor);
  return { markup, blocks };
}

export interface CompileOptions {
  createWorker: () => WorkerLike;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Compile every block, or fail the whole artifact. Partial results are never
 * returned: a half-compiled document is the blank-artifact bug, wearing a
 * different hat.
 */
export function compileBlocks(
  blocks: string[],
  options: CompileOptions,
): Promise<CompileOutcome> {
  if (blocks.length === 0) {
    return Promise.resolve({ kind: "ok", blocks: [] });
  }
  const timeoutMs = options.timeoutMs ?? COMPILE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? COMPILED_MAX_BYTES;
  return blocks.reduce<Promise<CompileOutcome>>(
    (chain, source) =>
      chain.then((acc) => {
        if (acc.kind !== "ok") return acc;
        return runBlock(source, options.createWorker, timeoutMs, maxBytes).then((one) => {
          if (one.kind !== "ok") return one;
          return { kind: "ok", blocks: [...acc.blocks, one.code] };
        });
      }),
    Promise.resolve<CompileOutcome>({ kind: "ok", blocks: [] }),
  );
}

type BlockOutcome =
  | { kind: "ok"; code: string }
  | { kind: "timeout" }
  | { kind: "too-big"; message: string }
  | { kind: "error"; message: string };

function runBlock(
  source: string,
  createWorker: () => WorkerLike,
  timeoutMs: number,
  maxBytes: number,
): Promise<BlockOutcome> {
  return new Promise<BlockOutcome>((resolve) => {
    const worker = createWorker();
    let settled = false;
    const finish = (outcome: BlockOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ kind: "timeout" });
    }, timeoutMs);
    worker.onmessage = (event: { data: unknown }) => {
      const data = event.data as { kind?: string; code?: string; bytes?: number };
      if (data.kind !== "ok" || typeof data.code !== "string") {
        finish({
          kind: "error",
          message: data.kind ?? "unknown worker reply",
        });
        return;
      }
      // The worker reports the byte count of what it produced; the cap is
      // checked before the code reaches the document.
      const bytes = data.bytes ?? data.code.length;
      if (bytes > maxBytes) {
        finish({
          kind: "too-big",
          message:
            `compiled artifact is ${String(bytes)} bytes, over the ${String(maxBytes)}-byte cap (D4): ` +
            "split it into smaller artifacts, or drop what it does not need",
        });
        return;
      }
      finish({ kind: "ok", code: data.code });
    };
    worker.onerror = (event: { message?: string }) => {
      finish({ kind: "error", message: event.message ?? "worker failed" });
    };
    try {
      worker.postMessage({ source });
    } catch (e) {
      finish({
        kind: "error",
        message: e instanceof Error ? e.message : "worker could not be started",
      });
    }
  });
}