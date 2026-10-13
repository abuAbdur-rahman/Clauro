/**
 * Artifact drawer column (Tasks 013 + 014, DESIGN.md §2.4).
 *
 * Four states, and they are the whole design: empty (zero width, no chrome),
 * compiling (says "compiling"), live (the sandboxed render), failed (the
 * reason). The fourth exists because a blank frame is indistinguishable from a
 * broken app, and this task exists so it never happens silently.
 *
 * The frame navigates to a document Rust serves (D123) under `sandbox=
 * "allow-scripts"` and **never** `allow-same-origin` — the opaque origin comes
 * from the attribute (D2), and without it the served document would report the
 * app's own. The bytes it receives are built by `prepareArtifact`, which takes
 * the CSP from Rust (D3), publishes them back through `artifact_publish`
 * (D123), and compiles JSX in a Worker (D4). No Tauri API is reachable from
 * inside; that is verified under a real webview in 021, not here.
 */
import { useEffect, useRef, useState } from "react";
import { useDrawerStore, sandboxAttr, artifactGate, type EngineGate } from "../features/artifact/store";
import { hostSide } from "../features/artifact/channel";
import {
  prepareArtifact,
  type PrepareInput,
  type PrepareResult,
} from "../features/artifact/prepare";

interface ArtifactDrawerProps {
  threadId: string;
  engine: EngineGate;
  /** The artifact tool's source, as stored. Prepared here, not by the caller. */
  source: string;
  mediaType: string;
  title: string;
  /** Injected in tests; production uses the Rust policy + real Worker.
   * A seam, not a control: nothing here can weaken the sandbox (D108). */
  fetchPolicy?: PrepareInput["fetchPolicy"];
  createWorker?: PrepareInput["createWorker"];
  /** Injected in tests; production publishes through `artifact_publish` (D123). */
  publishDoc?: PrepareInput["publishDoc"];
}

export function ArtifactDrawer({
  threadId,
  engine,
  source,
  mediaType,
  title,
  fetchPolicy,
  createWorker,
  publishDoc,
}: ArtifactDrawerProps) {
  const entry = useDrawerStore((s) => s.drawers[threadId]);
  // The prepared document belongs to ONE artifact (review 32 NIT): keeping the
  // result keyed by `artifactId` means a switched artifact derives `null`
  // below and presents "Compiling…" instead of the previous artifact's frame
  // (or its failure) while the new prepare runs.
  const [prepared, setPrepared] = useState<{ key: string; result: PrepareResult } | null>(null);

  const artifactId = entry?.artifactId ?? null;
  const version = entry?.version ?? null;
  const state = entry?.state ?? "empty";
  const result = prepared !== null && prepared.key === artifactId ? prepared.result : null;

  useEffect(() => {
    // Prepare when the artifact is *known* (D121): during compiling the
    // drawer says so, and the turn-done path lands straight in `live` — the
    // input is what changes the output, so the state is not a gate. With
    // `artifactId` and `source` in deps, the compiling→live flip of an
    // unchanged artifact re-runs nothing, while a refresh (new bytes)
    // re-prepares exactly once.
    if (artifactId === null) return undefined;
    let live = true;
    // Preparing is where the policy request, the Worker, the sanitiser and
    // the publish all happen, so the spinner covers exactly that window and
    // nothing more.
    prepareArtifact({ source, mediaType, fetchPolicy, createWorker, publishDoc })
      .then((out) => {
        if (live) setPrepared({ key: artifactId, result: out });
      })
      .catch((e: unknown) => {
        // `prepareArtifact` is written not to reject, but a rejected promise
        // here would leave the spinner up forever — the one state with no
        // exit. Surface it as a reason instead.
        if (live) {
          setPrepared({
            key: artifactId,
            result: {
              kind: "failed",
              reason: e instanceof Error ? e.message : String(e),
            },
          });
        }
      });
    return () => {
      live = false;
    };
  }, [artifactId, source, mediaType, fetchPolicy, createWorker, publishDoc]);

  // The channel's host half (D6/D122): attach when a live frame is on
  // screen, and re-attach on every new document — the transferred port dies
  // with the old document, so the handshake must run again for the new one.
  // `onReady` is the frame having claimed its port; an error-level report is
  // the frame's own complaint, shown in a muted status line BESIDE the live
  // frame — never a teardown (review 14 NIT): a frame-supplied string is
  // attributed to the frame, and the artifact stays on screen to look at.
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [channelReady, setChannelReady] = useState(false);
  const [frameReport, setFrameReport] = useState<string | null>(null);
  useEffect(() => {
    // `artifactId` guards the narrowing below and keys any failure it reports
    // to the artifact actually on screen (same one-artifact rule as above).
    if (result?.kind !== "live" || artifactId === null) return undefined;
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow) return undefined;
    setChannelReady(false);
    // A new document starts with a clean status line: the previous frame's
    // complaint says nothing about this one.
    setFrameReport(null);
    const host = hostSide({
      frameWindow,
      onLog: (report) => {
        if (report.level === "error") {
          setFrameReport(report.text);
        }
      },
      onReady: () => {
        setChannelReady(true);
      },
    });
    return () => {
      host.dispose();
      setChannelReady(false);
    };
  }, [result, artifactId]);

  const gate = artifactGate(engine);

  if (!gate.enabled) {
    return (
      <aside aria-label="artifact drawer disabled" className="w-80 shrink-0 border-l border-border p-4">
        <p className="font-mono text-xs text-destructive">{gate.notice}</p>
        {entry?.notice && (
          <p className="mt-1 font-mono text-xs text-muted-foreground">{entry.notice}</p>
        )}
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
      <aside aria-label="artifact drawer" className="w-80 shrink-0 border-l border-border p-4">
        <h2 className="font-mono text-xs text-foreground">{title}</h2>
        <p className="mt-2 font-mono text-xs text-destructive">{result.reason}</p>
      </aside>
    );
  }

  if (result === null) {
    return (
      <aside aria-label="artifact drawer" className="w-80 shrink-0 border-l border-border p-4">
        <p className="font-mono text-xs text-muted-foreground">Compiling…</p>
      </aside>
    );
  }

  return (
    <aside aria-label="artifact drawer" className="w-80 shrink-0 border-l border-border p-4">
      <h2 className="font-mono text-xs text-foreground">{title}</h2>
      <p className="font-mono text-xs text-muted-foreground">v{version}</p>
      <iframe
        ref={frameRef}
        title="artifact-frame"
        sandbox={sandboxAttr()}
        // D123: the host owns the bytes, the frame navigates to its URL. The
        // sandbox attribute above is still the only boundary — the origin is
        // opaque because of it, not because of how the document arrives.
        src={result.url}
        className="mt-2 h-96 w-full bg-background"
        data-artifact-channel={channelReady ? "ready" : "pending"}
      />
      {frameReport !== null && (
        <p
          data-testid="artifact-frame-report"
          className="mt-2 font-mono text-xs text-muted-foreground"
        >
          frame: {frameReport}
        </p>
      )}
    </aside>
  );
}