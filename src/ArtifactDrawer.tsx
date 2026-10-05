/**
 * Artifact drawer column (Task 013, DESIGN.md §2.4).
 *
 * Three states, and they are the whole design: empty (zero width, no chrome),
 * compiling (says "compiling"), live (the sandboxed render). The frame is
 * `srcdoc` transport with `sandbox="allow-scripts"` and never
 * `allow-same-origin` — the opaque origin comes from the attribute (D2).
 * No network can leave the frame (D3, CSP in 014); no Tauri internals are
 * reachable from it (verified under a real webview in 021, not here).
 */
import { useDrawerStore, sandboxAttr, artifactGate, type EngineGate } from "./artifact";

interface ArtifactDrawerProps {
  threadId: string;
  engine: EngineGate;
  /** Compiled output for the live state; empty until the Worker finishes (014). */
  sourceHtml: string;
  title: string;
}

export function ArtifactDrawer({ threadId, engine, sourceHtml, title }: ArtifactDrawerProps) {
  const entry = useDrawerStore((s) => s.drawers[threadId]);
  const gate = artifactGate(engine);

  if (!gate.enabled) {
    return (
      <aside aria-label="artifact drawer disabled" className="w-80 shrink-0 border-l border-neutral-800 p-4">
        <p className="font-mono text-xs text-amber-300">{gate.notice}</p>
        {entry?.notice && <p className="mt-1 font-mono text-xs text-neutral-500">{entry.notice}</p>}
      </aside>
    );
  }

  if (!entry || entry.state === "empty") {
    return <aside aria-hidden="true" aria-label="artifact drawer" className="w-0 overflow-hidden" />;
  }

  if (entry.state === "compiling") {
    return (
      <aside aria-label="artifact drawer" className="w-80 shrink-0 border-l border-neutral-800 p-4">
        <p className="font-mono text-xs text-neutral-400">Compiling…</p>
      </aside>
    );
  }

  return (
    <aside aria-label="artifact drawer" className="w-80 shrink-0 border-l border-neutral-800 p-4">
      <h2 className="font-mono text-xs text-neutral-200">{title}</h2>
      <p className="font-mono text-[11px] text-neutral-500">v{entry.version}</p>
      <iframe
        title="artifact-frame"
        sandbox={sandboxAttr()}
        srcDoc={sourceHtml}
        className="mt-2 h-96 w-full bg-white"
      />
    </aside>
  );
}
