/**
 * The compile Worker (D4). It exists so one artifact's pathological input
 * cannot occupy the thread that keeps the app's UI responsive: Sucrase runs
 * here, and the host terminates this worker if it takes longer than the
 * budget or produces more than the cap.
 *
 * The transform comes from `compile.transform.ts`, which this file is the only
 * shipped importer of. The host's tests import it from there too, so there is
 * no second copy to drift and no path from the main bundle to Sucrase.
 */
import { transformJsx } from "./compile.transform";

self.onmessage = (event: MessageEvent) => {
  const source = (event.data as { source?: unknown }).source;
  if (typeof source !== "string") {
    self.postMessage({ kind: "error", message: "no source to compile" });
    return;
  }
  const out = transformJsx(source);
  if (out.kind === "error") {
    // Reported as an error reply, not an uncaught throw: the host distinguishes
    // "the artifact is wrong" from "the worker died".
    self.postMessage({ kind: "error", message: out.message });
    return;
  }
  self.postMessage({ kind: "ok", code: out.code, bytes: out.code.length });
};