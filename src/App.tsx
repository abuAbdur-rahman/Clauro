/**
 * Boot gate (Task 003, D53). A missing WebView2 runtime is detected and
 * explained before first paint — never a blank window, never a bare crash.
 */
import { useEffect, useState } from "react";
import { refreshCatalogue, shortError, webviewStatus, type CataloguePayload } from "./catalogue";
import ModelPicker from "./ModelPicker";
import { useThreadStore } from "./thread";
import { ArtifactDrawer } from "./ArtifactDrawer";

const THREAD = "thread-001";

type Boot = { stage: "checking" } | { stage: "missing"; hint: string } | { stage: "ready" };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ stage: "checking" });
  const [payload, setPayload] = useState<CataloguePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openThread = useThreadStore((s) => s.openThread);
  const model = useThreadStore((s) => s.threads[THREAD]?.model ?? null);
  const effort = useThreadStore((s) => s.threads[THREAD]?.effort ?? "medium");

  useEffect(() => {
    // Read through a call: property narrowing would otherwise conclude the
    // flag never changes (the mutation lives in the cleanup closure, which the
    // analyser cannot see) and flag every check as unnecessary.
    const cancelled = { value: false };
    const isCancelled = () => cancelled.value;
    void (async () => {
      try {
        const status = await webviewStatus();
        if (isCancelled()) return;
        if (status.kind === "missing") {
          setBoot({ stage: "missing", hint: status.hint });
          return;
        }
        setBoot({ stage: "ready" });
        openThread(THREAD);
        const cat = await refreshCatalogue();
        if (!isCancelled()) setPayload(cat);
      } catch (e) {
        if (!isCancelled()) setError(shortError(e));
      }
    })();
    return () => {
      cancelled.value = true;
    };
  }, [openThread]);

  if (boot.stage === "checking") {
    return <p className="p-4 font-mono text-sm text-neutral-500">Starting Clauro…</p>;
  }

  if (boot.stage === "missing") {
    return (
      <div className="min-h-screen bg-neutral-950 p-6 font-mono text-sm text-neutral-300">
        <h1 className="text-base text-neutral-100">Clauro cannot start its window</h1>
        <p className="mt-2">{boot.hint}</p>
        <p className="mt-1 text-neutral-500">Your data is untouched. Install the runtime and relaunch.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 p-4 font-mono text-sm text-neutral-300">
      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-base">Clauro — model catalogue (003)</h1>
          <p className="mt-1 text-xs text-neutral-500">
            thread {THREAD} · model {model ? `${model.provider}/${model.id}` : "none"} · effort {effort}
          </p>
          {error && <p className="mt-2 text-xs text-red-400">Boot error: {error}</p>}
          <div className="mt-3 max-w-2xl">
            {payload ? (
              <ModelPicker payload={payload} threadId={THREAD} />
            ) : (
              <p className="text-neutral-500">Loading catalogue…</p>
            )}
          </div>
        </div>
        {/* Engine gate is prop-driven: the shell passes the real verdict once
            the Tauri runtime check exists (021). Windows-verified is the dev
            default per AGENTS.md §8a. */}
        <ArtifactDrawer
          threadId={THREAD}
          engine={{ platform: "windows", opaqueProven: true }}
          sourceHtml=""
          title=""
        />
      </div>
    </div>
  );
}
