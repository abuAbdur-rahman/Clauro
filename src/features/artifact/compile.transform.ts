/**
 * Sucrase, and only here (D4).
 *
 * This module is imported by `compile.worker.ts` and by nothing the host
 * bundle reaches. That is the whole reason it is its own file: a static import
 * of Sucrase from `compile.ts` would put ~200 KB in the main chunk and make it
 * *possible* for the host to compile an artifact on its own thread, which is
 * the failure D4 exists to prevent — a pathological artifact occupying the
 * thread that keeps the UI responsive.
 *
 * `compile.test.ts` asserts that separation from the import graph, so a later
 * "just import it here" cannot quietly undo it.
 */
import { transform } from "sucrase";

export type Transform =
  | { kind: "ok"; code: string }
  | { kind: "error"; message: string };

/** Anything thrown that is not an `Error` still has to become text, without
 * `[object Object]` reaching a log line or a UI. */
export function describeThrown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    const json: unknown = JSON.stringify(value);
    return typeof json === "string" && json !== "" ? json : "unknown failure";
  } catch {
    // A thrown object with a cyclic reference, or a BigInt inside JSON.
    return "unknown failure";
  }
}

/** One block. Never throws: a parse failure is `kind: "error"`. */
export function transformJsx(source: string): Transform {
  try {
    const out = transform(source, {
      // Exactly the set 014 specifies: JSX + TypeScript + ESM→CJS, because the
      // frame runs the module through a factory with no loader.
      transforms: ["typescript", "jsx", "imports"],
      jsxPragma: "h",
      jsxFragmentPragma: "Fragment",
      production: true,
    });
    return { kind: "ok", code: out.code };
  } catch (e) {
    // Sucrase's parse errors carry a message; a thrown non-Error still has to
    // become a string rather than leaking an object into the UI.
    return {
      kind: "error",
      message: e instanceof Error ? e.message : describeThrown(e),
    };
  }
}