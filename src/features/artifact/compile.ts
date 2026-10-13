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
/**
 * Where the HTML tokenizer ends a script element, for the extractor (audit 14).
 * `"</script>"` alone misses `</SCRIPT>`, `</script >` and `</script\n>` — closes
 * the tokenizer honours — and a missed close lands the block's tail inside the
 * envelope's compiled `<script>` context. The pattern can also close *earlier*
 * than the tokenizer (a quoted `>` inside an attribute), which errs toward less
 * code in the block and more of it as inert markup — never more code.
 */
const BLOCK_CLOSE_PATTERN = /<\/script(?:[\s/][^>]*)?>/gi;

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
    // Exec, not indexOf: the close must be the one the tokenizer would honour,
    // case-insensitively and across the whitespace the tag name allows.
    BLOCK_CLOSE_PATTERN.lastIndex = bodyStart;
    const close = BLOCK_CLOSE_PATTERN.exec(source);
    if (!close) break;
    const end = close.index;
    blocks.push(source.slice(bodyStart, end));
    markup += `${source.slice(cursor, start)}<!--jsx:${String(blocks.length - 1)}-->`;
    cursor = end + close[0].length;
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
      // The worker's byte count is a claim about its own untrusted output;
      // recompute it here (audit 14). `TextEncoder` is a platform global, so
      // the module keeps its zero-import property (asserted in compile.test).
      const bytes = new TextEncoder().encode(data.code).length;
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