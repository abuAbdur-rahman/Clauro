/**
 * Artifact drawer column (Tasks 013 + 014, DESIGN.md §2.4).
 *
 * Four states, and they are the whole design: empty (zero width, no chrome),
 * compiling (says "compiling"), live (the sandboxed render), failed (the
 * reason). The fourth exists because a blank frame is indistinguishable from a
 * broken app, and this task exists so it never happens silently.
 *
 * The frame is `srcdoc` transport with `sandbox="allow-scripts"` and **never**
 * `allow-same-origin` — the opaque origin comes from the attribute (D2), and
 * `srcdoc` on its own would inherit ours. The document it receives is built by
 * `prepareArtifact`, which takes the CSP from Rust (D3) and compiles JSX in a
 * Worker (D4). No Tauri API is reachable from inside; that is verified under a
 * real webview in 021, not here.
 */
import { useEffect, useState } from "react";
import { useDrawerStore, sandboxAttr, artifactGate, type EngineGate } from "../features/artifact/store";
import { prepareArtifact, type PrepareResult } from "../features/artifact/prepare";

interface ArtifactDrawerProps {
  threadId: string;
  engine: EngineGate;
  /** The artifact tool's source, as stored. Prepared here, not by the caller. */
  source: string;
  mediaType: string;
  title: string;
}

export function ArtifactDrawer({ threadId, engine, source, mediaType, title }: ArtifactDrawerProps) {
  const entry = useDrawerStore((s) => s.drawers[threadId]);
  const [result, setResult] = useState<PrepareResult | null>(null);

  const artifactId = entry?.artifactId ?? null;
  const version = entry?.version ?? null;
  const state = entry?.state ?? "empty";

  useEffect(() => {
    if (state !== "compiling" || artifactId === null) return undefined;
    let live = true;
    // Preparing is where the policy request, the Worker and the sanitiser all
    // happen, so the spinner covers exactly that window and nothing more.
    prepareArtifact({ source, mediaType })
      .then((out) => {
        if (live) setResult(out);
      })
      .catch((e: unknown) => {
        // `prepareArtifact` is written not to reject, but a rejected promise
        // here would leave the spinner up forever — the one state with no
        // exit. Surface it as a reason instead.
        if (live) {
          setResult({
            kind: "failed",
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      live = false;
    };
  }, [state, artifactId, source, mediaType]);

  const gate = artifactGate(engine);

  if (!gate.enabled) {
    return (
      <aside aria-label="artifact drawer disabled" className="w-80 shrink-0 border-l border-neutral-800 p-4">
        <p className="font-mono text-xs text-amber-300">{gate.notice}</p>
        {entry?.notice && <p className="mt-1 font-mono text-xs text-neutral-500">{entry.notice}</p>}
      </aside>
    );
  }

  if (state === "empty" && result === null) {
    return <aside aria-hidden="true" aria-label="artifact drawer" className="w-0 overflow-hidden" />;
  }

  // Prepared wins over "compiling": the store records that the model asked for
  // an artifact, while `result` records what this one actually became. Waiting
  // for the store to advance would leave a finished compile spinning forever.
  if (result?.kind === "failed") {
    return (
      <aside aria-label="artifact drawer" className="w-80 shrink-0 border-l border-neutral-800 p-4">
        <h2 className="font-mono text-xs text-neutral-200">{title}</h2>
        <p className="mt-2 font-mono text-xs text-red-400">{result.reason}</p>
      </aside>
    );
  }

  if (result === null) {
    return (
      <aside aria-label="artifact drawer" className="w-80 shrink-0 border-l border-neutral-800 p-4">
        <p className="font-mono text-xs text-neutral-400">Compiling…</p>
      </aside>
    );
  }

  return (
    <aside aria-label="artifact drawer" className="w-80 shrink-0 border-l border-neutral-800 p-4">
      <h2 className="font-mono text-xs text-neutral-200">{title}</h2>
      <p className="font-mono text-[11px] text-neutral-500">v{version}</p>
      <iframe
        title="artifact-frame"
        sandbox={sandboxAttr()}
        srcDoc={result.doc}
        className="mt-2 h-96 w-full bg-white"
      />
    </aside>
  );
}