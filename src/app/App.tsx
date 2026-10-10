/**
 * Boot gate (Task 003, D53). A missing WebView2 runtime is detected and
 * explained before first paint — never a blank window, never a bare crash.
 */
import { useEffect, useMemo, useState } from "react";
import { shortError, webviewStatus } from "../features/catalogue/catalogue";
import Composer from "../components/Composer";
import ModelPicker from "../components/ModelPicker";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { useThreadStore, type ThreadStatus } from "../features/catalogue/thread";
import { ProvidersView } from "../features/providers/ProvidersView";
import { ChatView } from "../features/turn/ChatView";
import { ArtifactDrawer } from "../components/ArtifactDrawer";
import { ProjectsRail, type RailThread } from "../features/projects/ProjectsRail";
import { ProjectsGrid } from "../features/projects/ProjectsGrid";
import { ProjectDetail } from "../features/projects/ProjectDetail";
import { HomeGreeting } from "../features/home/HomeGreeting";
import { CommandPalette } from "../features/shell/CommandPalette";
import { useSettingsHotkey, useSummonHotkey } from "../features/shell/hotkey";
import { useSettingsStore } from "../features/shell/settings";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { useArtifactContent } from "../features/artifact/live";
import { useTheme } from "../features/shell/usetheme";
import { TitleBar } from "./TitleBar";

const THREAD = "thread-001";

/** Threads rendered by the rail (Task 029 indicator wiring reads these ids). */
const THREADS_BY_PROJECT: Readonly<Record<string, readonly { id: string; title: string }[]>> = {
  default: [{ id: THREAD, title: "First thread" }],
};

const THREAD_IDS: readonly string[] = Object.values(THREADS_BY_PROJECT).flatMap((ts) =>
  ts.map((t) => t.id),
);

/** Intent collection only; dispatch belongs to the turn loop (023). */
function noop(): void {
  // Wired to real handlers by their owning tasks.
}

/**
 * Home suggestion chips. Text mirrors SEED_SUGGESTIONS verbatim, restated
 * here because the real shell must never import the mock seed
 * (shell.mockmode.test.ts) — the mock seed owns the canonical list.
 */
const HOME_SUGGESTIONS: readonly string[] = [
  "Explain a concept",
  "Draft an email",
  "Debug my code",
  "Plan a project",
];

/**
 * Fill the composer's controlled draft without touching the Composer: set
 * through the native setter so React's value tracker sees the change, then
 * dispatch `input` so its onChange writes state. Focus follows (html:368
 * `chip` action focuses the composer after filling).
 */
function fillComposerDraft(text: string): void {
  const box = document.querySelector('textarea[aria-label="Message"]');
  if (!(box instanceof HTMLTextAreaElement)) return;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- grabbing the native setter is the entire point (bypass React's value tracker); it is rebound via Reflect.apply below, never called unbound.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter !== undefined) {
    Reflect.apply(setter, box, [text]);
  } else {
    box.value = text;
  }
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
}

const DEMO_PROJECTS = [
  { id: "default", name: "Default" },
  { id: "research", name: "Research" },
];

/**
 * Mock mode sits in the same state as the html truth (Task 029 follow-up):
 * the rail renders the seed chats/projects instead of the demo pair.
 * Detected via the vite mode (`dev:mock` uses `--mode mock`, and a preview
 * of a `--mode mock` build too); vitest runs as mode "test", so unit tests
 * always exercise the real path.
 */
function isMockMode(): boolean {
  return import.meta.env.MODE === "mock";
}

/**
 * Structural seed shapes mirrored from the mock seed. Restated here because
 * the real shell must never import the mock module — not even the type
 * (shell.mockmode.test.ts greps the raw source).
 */
export interface SeedRailChatInput {
  id: string;
  title: string;
  pinned: boolean;
  projectId: string | null;
  updated: string;
}

export interface SeedRailProjectInput {
  id: string;
  name: string;
  desc?: string;
  updated?: string;
  instructions?: string;
  files?: readonly { name: string; size: string }[];
}

export interface SeedRail {
  /** Flat rows for the rail `chats` prop (date groups stay flat, like html). */
  chats: RailThread[];
  /** Seed projects mapped to the rail/grid `Project` shape. */
  projects: { id: string; name: string; desc?: string; updatedAt?: string }[];
  /** Project-owned chats nested under their project; unprojected stay flat. */
  threadsByProject: Record<string, { id: string; title: string }[]>;
  /** One store update stamp per chat at the seed instant. */
  updates: { id: string; updatedAt: number }[];
  /** Chat counts per project for the grid cards (from the same grouping). */
  chatCountByProject: Record<string, number>;
  /** Detail content per project: instructions + files with parsed byte sizes. */
  meta: Record<string, { instructions: string; files: { name: string; sizeBytes: number }[] }>;
}

/**
 * Parse html-seed file sizes ("210 KB", "1.2 MB") to bytes. Unknown units
 * honestly resolve to 0 — never a fabricated number.
 */
export function parseSeedSize(size: string): number {
  const m = size.trim().match(/^([\d.]+)\s*(B|KB|MB|GB)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2].toUpperCase();
  const mult = unit === "B" ? 1 : unit === "KB" ? 1024 : unit === "MB" ? 1024 ** 2 : 1024 ** 3;
  return Math.round(n * mult);
}

export interface MockDetailProps {
  instructions: string;
  chats: { id: string; title: string }[];
  files: { name: string; sizeBytes: number }[];
}

/**
 * Pure detail props for one project: null rail (real path) yields honest
 * empties; a seed rail yields instructions + owned chats + files.
 */
export function mockDetailProps(rail: SeedRail | null, projectId: string): MockDetailProps {
  const meta = rail?.meta[projectId];
  return {
    instructions: meta?.instructions ?? "",
    chats: (rail?.threadsByProject[projectId] ?? []).map((t) => ({ id: t.id, title: t.title })),
    files: meta?.files ?? [],
  };
}

/**
 * Pure seed → rail mapping. Kept pure (no store, no Tauri) so unit tests can
 * pin it without running mock MODE under vitest.
 */
export function seedToRail(
  chats: readonly SeedRailChatInput[],
  projects: readonly SeedRailProjectInput[],
): SeedRail {
  return {
    chats: chats.map((c) => ({
      id: c.id,
      title: c.title,
      projectId: c.projectId,
      updated: c.updated,
      pinned: c.pinned,
    })),
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.desc !== undefined ? { desc: p.desc } : {}),
      ...(p.updated !== undefined ? { updatedAt: p.updated } : {}),
    })),
    threadsByProject: Object.fromEntries(
      projects.map((p) => [
        p.id,
        chats
          .filter((c) => c.projectId === p.id)
          .map((c) => ({ id: c.id, title: c.title })),
      ]),
    ),
    updates: chats.map((c) => ({ id: c.id, updatedAt: Date.parse(c.updated) })),
    chatCountByProject: Object.fromEntries(
      projects.map((p) => [p.id, chats.filter((c) => c.projectId === p.id).length]),
    ),
    meta: Object.fromEntries(
      projects.map((p) => [
        p.id,
        {
          instructions: p.instructions ?? "",
          files: (p.files ?? []).map((f) => ({ name: f.name, sizeBytes: parseSeedSize(f.size) })),
        },
      ]),
    ),
  };
}

type Boot = { stage: "checking" } | { stage: "missing"; hint: string } | { stage: "ready" };
type View =
  | { name: "home" }
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "chat" };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ stage: "checking" });
  const [error, setError] = useState<string | null>(null);
  const openThread = useThreadStore((s) => s.openThread);
  const markRead = useThreadStore((s) => s.markRead);
  // Mock-mode seed state (null on the real path). Declared before the
  // indicator memo below because the memo reads `railChats`.
  const [mockSeed, setMockSeed] = useState<{ rail: SeedRail; now: number } | null>(null);
  const railChats: readonly RailThread[] | undefined = mockSeed?.rail.chats;
  const railProjects: readonly { id: string; name: string; desc?: string; updatedAt?: string }[] =
    mockSeed?.rail.projects ?? DEMO_PROJECTS;
  const railThreadsByProject: Readonly<Record<string, readonly { id: string; title: string }[]>> =
    mockSeed?.rail.threadsByProject ?? THREADS_BY_PROJECT;
  // Indicator state for every rendered thread id (Task 029 B11) via the
  // store's `statusOf`. `statusOf` itself is a stable reference, so reactivity
  // comes from the `running`/`threads` slices; the map is memoized so the
  // selector identity stays stable (a fresh object per snapshot loops React).
  const statusOf = useThreadStore((s) => s.statusOf);
  const running = useThreadStore((s) => s.running);
  const threadStates = useThreadStore((s) => s.threads);
  const statusByThread = useMemo<Record<string, ThreadStatus>>(() => {
    const out: Record<string, ThreadStatus> = {};
    const ids = railChats === undefined ? THREAD_IDS : railChats.map((c) => c.id);
    for (const id of ids) out[id] = statusOf(id);
    return out;
    // Reactive inputs are the `running` + `threads` slices subscribed above:
    // `statusOf` reads them from the store snapshot, so listing them here
    // invalidates the map exactly when indicator state can change.
    // `railChats` flips once when the mock seed lands (never on real).
  }, [statusOf, running, threadStates, railChats]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [view, setView] = useState<View>({ name: "home" });
  const [providersOpen, setProvidersOpen] = useState(false);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const displayName = useSettingsStore((s) => s.displayName);
  const artifactContent = useArtifactContent((s) => s.threads[THREAD]);
  useSummonHotkey(() => {
    setPaletteOpen(true);
  });
  useSettingsHotkey(() => {
    openSettings("providers");
  });


  // Device theme, followed live and user-overridable (Appearance pane):
  // white surfaces only exist in light mode. Previously a hardcoded `false`
  // pinned the shell to light tokens on a dark OS — proven by the running
  // app 2026-10-07. `useTheme` owns the subscription; `applyTheme` stays pure
  // so its unit tests keep passing injected values.
  useTheme();

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
        if (isMockMode()) {
          // Dynamic relative import: the mock chunk loads only on this
          // branch, so the real bundle stays mock-free, and the raw source
          // keeps zero mock-module literals (shell.mockmode.test.ts).
          // None read → with markUpdated set and lastReadAt 0 every seed
          // row reads not-viewed/done honestly via the wired statusOf.
          void import("../mock/seed")
            .then((mod) => {
              if (isCancelled()) return;
              const rail = seedToRail(mod.SEED_CHATS, mod.SEED_PROJECTS);
              const store = useThreadStore.getState();
              for (const chat of mod.SEED_CHATS) {
                store.openThread(chat.id);
              }
              for (const u of rail.updates) {
                store.markUpdated(u.id, u.updatedAt);
              }
              if (!isCancelled()) setMockSeed({ rail, now: mod.SEED_NOW });
            })
            .catch((e: unknown) => {
              if (!isCancelled()) setError(shortError(e));
            });
        }
      } catch (e) {
        if (!isCancelled()) setError(shortError(e));
      }
    })();
    return () => {
      cancelled.value = true;
    };
  }, [openThread]);

  if (boot.stage === "checking") {
    return <p className="p-4 font-mono text-sm text-muted-foreground">Starting Clauro…</p>;
  }

  if (boot.stage === "missing") {
    return (
      <div className="min-h-screen bg-background p-6 font-mono text-sm text-foreground">
        <h1 className="text-base">Clauro cannot start its window</h1>
        <p className="mt-2">{boot.hint}</p>
        <p className="mt-1 text-muted-foreground">Your data is untouched. Install the runtime and relaunch.</p>
      </div>
    );
  }

  const project = view.name === "project" ? railProjects.find((p) => p.id === view.id) : undefined;
  const detail =
    view.name === "project" && project ? mockDetailProps(mockSeed?.rail ?? null, project.id) : null;
  const title =
    view.name === "chat"
      ? "First thread"
      : view.name === "project"
        ? (project?.name ?? "Project")
        : view.name === "projects"
          ? "Projects"
          : undefined;

  // Home send routes through the thread store (it owns threads) into the
  // chat view. The turn loop (023) owns dispatch from there; the old `noop`
  // dead-end is gone.
  function handleHomeSend(): void {
    openThread(THREAD);
    if (isMockMode()) {
      useThreadStore.getState().markUpdated(THREAD, Date.now());
    }
    setView({ name: "chat" });
  }

  return (
    <div className="flex h-dvh w-screen flex-col overflow-hidden bg-background font-sans text-sm text-foreground">
      <TitleBar title={title} />
      <CommandPalette state={{ turnRunning: false }} open={paletteOpen} />
      <SettingsDialog threadId={THREAD} />
      <Dialog
        open={providersOpen}
        onOpenChange={(next) => {
          if (!next) setProvidersOpen(false);
        }}
      >
        <DialogContent
          aria-label="Providers"
          className="h-[min(640px,calc(100dvh-2rem))] w-[min(920px,calc(100vw-2rem))] max-w-none gap-0 overflow-y-auto p-4 sm:max-w-[min(920px,calc(100vw-2rem))]"
        >
          <DialogHeader className="pb-2 text-left">
            <DialogTitle className="text-sm">Providers</DialogTitle>
          </DialogHeader>
          <ProvidersView />
        </DialogContent>
      </Dialog>
      <div className="flex min-h-0 flex-1 items-stretch gap-0">
        {/* Shrink-0 shell only: the rail sets its own width (260px open,
            48px collapsed) from SidebarProvider state, so this wrapper must
            size to content, never pin it. Pinning it was the bug that crushed
            the center column to zero (proven in-browser 2026-10-07). */}
        <div className="shrink-0 self-stretch overflow-hidden">
          <ProjectsRail
            projects={railProjects}
            memoryOff={false}
            threadsByProject={railThreadsByProject}
            chats={railChats}
            now={mockSeed?.now}
            statusByThread={statusByThread}
            onSelectProject={(id) => {
              setView({ name: "project", id });
            }}
            onSelectThread={(id) => {
              setView({ name: "chat" });
              // Viewed-on-open (Task 029 B11): the click is the signal.
              // Guard on existence — markRead throws for unknown ids.
              if (useThreadStore.getState().threads[id] !== undefined) {
                markRead(id, Date.now());
              }
            }}
            onSearch={() => {
              setPaletteOpen(true);
            }}
            onOpenProjects={() => {
              setView({ name: "projects" });
            }}
            onOpenSettings={() => {
              openSettings("providers");
            }}
          />
        </div>
        <div className="min-h-0 min-w-0 flex-1 p-4">
          {view.name === "home" && (
            <div className="mx-auto flex h-full w-full max-w-[720px] flex-col">
              <div data-testid="home-header" className="flex items-center gap-2 py-2">
                <span className="text-sm font-medium">New chat</span>
                <span className="flex-1" />
                <ModelPicker threadId={THREAD} compact />
              </div>
              <div className="flex flex-1 flex-col items-center justify-center">
                <HomeGreeting hour={new Date().getHours()} name={displayName} />
                <p className="mt-2 text-sm text-muted-foreground">What can I help with?</p>
                <div className="mt-6 w-full">
                  <Composer
                    threadId={THREAD}
                    memoryOff={false}
                    onSend={handleHomeSend}
                    onAttach={noop}
                    onMemoryToggle={noop}
                  />
                  <p className="mt-2 text-center text-xs text-muted-foreground">
                    Clauro runs on your machine. Double-check important answers.
                  </p>
                </div>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {HOME_SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => {
                        fillComposerDraft(suggestion);
                      }}
                      className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-accent"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
                <div className="mt-6 flex justify-center gap-4">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:underline"
                    onClick={() => {
                      setView({ name: "projects" });
                    }}
                  >
                    Browse projects
                  </button>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:underline"
                    onClick={() => {
                      setProvidersOpen(true);
                    }}
                  >
                    Providers
                  </button>
                </div>
              </div>
            </div>
          )}
          {view.name === "projects" && (
            <ProjectsGrid
              projects={railProjects}
              chatCountByProject={mockSeed?.rail.chatCountByProject}
              onNew={noop}
              onOpen={(id) => {
                setView({ name: "project", id });
              }}
            />
          )}
          {view.name === "project" && project && detail && (
            <ProjectDetail
              project={project}
              instructions={detail.instructions}
              memoryCount={0}
              contextUsed="0%"
              chats={detail.chats}
              files={detail.files}
              onOpenChat={() => {
                setView({ name: "chat" });
              }}
              onStartChat={() => {
                setView({ name: "chat" });
              }}
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
        </div>
        {/* Engine gate is prop-driven: the shell passes the real verdict once
            the Tauri runtime check exists (021). Windows-verified is the dev
            default per AGENTS.md §8a. The artifact content rides the
            producer's store (D121); empty means nothing has been produced. */}
        <ArtifactDrawer
          threadId={THREAD}
          engine={{ platform: "windows", opaqueProven: true }}
          source={artifactContent?.source ?? ""}
          mediaType={artifactContent?.mediaType ?? "text/html"}
          title={artifactContent?.title ?? ""}
        />
      </div>
    </div>
  );
}
