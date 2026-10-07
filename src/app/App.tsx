/**
 * Boot gate (Task 003, D53). A missing WebView2 runtime is detected and
 * explained before first paint — never a blank window, never a bare crash.
 */
import { useEffect, useState } from "react";
import { shortError, webviewStatus } from "../features/catalogue/catalogue";
import Composer from "../components/Composer";
import { useThreadStore } from "../features/catalogue/thread";
import { ProvidersView } from "../features/providers/ProvidersView";
import { ChatView } from "../features/turn/ChatView";
import { ArtifactDrawer } from "../components/ArtifactDrawer";
import { ProjectsRail } from "../features/projects/ProjectsRail";
import { ProjectsGrid } from "../features/projects/ProjectsGrid";
import { ProjectDetail } from "../features/projects/ProjectDetail";
import { HomeGreeting } from "../features/home/HomeGreeting";
import { CommandPalette } from "../features/shell/CommandPalette";
import { applyTheme } from "../features/shell/theme";
import { useSummonHotkey } from "../features/shell/hotkey";

const THREAD = "thread-001";

/** Intent collection only; dispatch belongs to the turn loop (023). */
function noop(): void {
  // Wired to real handlers by their owning tasks.
}

const DEMO_PROJECTS = [
  { id: "default", name: "Default" },
  { id: "research", name: "Research" },
];

type Boot = { stage: "checking" } | { stage: "missing"; hint: string } | { stage: "ready" };
type View =
  | { name: "home" }
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "chat" }
  | { name: "providers" };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ stage: "checking" });
  const [error, setError] = useState<string | null>(null);
  const openThread = useThreadStore((s) => s.openThread);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [view, setView] = useState<View>({ name: "home" });
  useSummonHotkey(() => {
    setPaletteOpen(true);
  });


  useEffect(() => {
    applyTheme({ mode: "system", accent: "neutral", density: "comfortable" }, false);
  }, []);

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

  const project = view.name === "project" ? DEMO_PROJECTS.find((p) => p.id === view.id) : undefined;

  return (
    <div className="min-h-screen bg-neutral-950 p-4 font-mono text-sm text-neutral-300">
      <CommandPalette state={{ turnRunning: false }} open={paletteOpen} />
      <div className="flex gap-4">
        <ProjectsRail
          projects={DEMO_PROJECTS}
          memoryOff={false}
          threadsByProject={{ default: [{ id: THREAD, title: "First thread" }] }}
          onSelectProject={(id) => {
            setView({ name: "project", id });
          }}
          onSelectThread={() => {
            setView({ name: "chat" });
          }}
        />
        <div className="min-w-0 flex-1">
          {view.name === "home" && (
            <div className="mx-auto mt-24 max-w-2xl">
              <HomeGreeting hour={new Date().getHours()} />
              <div className="mt-6">
                <Composer
                  threadId={THREAD}
                  memoryOff={false}
                  onSend={noop}
                  onAttach={noop}
                  onMemoryToggle={noop}
                />
                <p className="mt-2 text-center text-xs text-neutral-500">
                  Clauro runs on your machine. Double-check important answers.
                </p>
              </div>
              <div className="mt-6 flex justify-center gap-4">
                <button
                  type="button"
                  className="text-xs text-neutral-400 hover:underline"
                  onClick={() => {
                    setView({ name: "projects" });
                  }}
                >
                  Browse projects
                </button>
                <button
                  type="button"
                  className="text-xs text-neutral-400 hover:underline"
                  onClick={() => {
                    setView({ name: "providers" });
                  }}
                >
                  Providers
                </button>
              </div>
            </div>
          )}
          {view.name === "projects" && (
            <ProjectsGrid
              projects={DEMO_PROJECTS}
              onNew={noop}
              onOpen={(id) => {
                setView({ name: "project", id });
              }}
            />
          )}
          {view.name === "project" && project && (
            <ProjectDetail
              project={project}
              instructions=""
              memoryCount={0}
              contextUsed="0%"
              onBack={() => {
                setView({ name: "projects" });
              }}
            />
          )}
          {view.name === "chat" && (
            <div>
              <h1 className="text-base">Clauro</h1>
              {error && <p className="mt-2 text-xs text-red-400">Boot error: {error}</p>}
              <ChatView threadId={THREAD} />
            </div>
          )}
          {view.name === "providers" && (
            <div className="mx-auto mt-8 max-w-2xl">
              <button
                type="button"
                className="text-xs text-neutral-400 hover:underline"
                onClick={() => {
                  setView({ name: "home" });
                }}
              >
                ← Back
              </button>
              <div className="mt-4">
                <ProvidersView />
              </div>
            </div>
          )}
        </div>
        {/* Engine gate is prop-driven: the shell passes the real verdict once
            the Tauri runtime check exists (021). Windows-verified is the dev
            default per AGENTS.md §8a. */}
        <ArtifactDrawer
          threadId={THREAD}
          engine={{ platform: "windows", opaqueProven: true }}
          source=""
          mediaType="text/html"
          title=""
        />
      </div>
    </div>
  );
}
