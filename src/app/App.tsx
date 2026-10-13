/**
 * Boot gate (Task 003, D53). A missing WebView2 runtime is detected and
 * explained before first paint — never a blank window, never a bare crash.
 */
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { shortError, webviewStatus } from "../features/catalogue/catalogue";
import Composer from "../components/Composer";
import ModelPicker from "../components/ModelPicker";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { useThreadStore, type ThreadStatus } from "../features/catalogue/thread";
import { ProjectsRail, type RailThread } from "../features/projects/ProjectsRail";
import { HomeGreeting } from "../features/home/HomeGreeting";
import {
  useCompactHotkey,
  useMaximizeHotkey,
  useNewChatHotkey,
  useSettingsHotkey,
  useSummonHotkey,
} from "../features/shell/hotkey";
import { useSettingsStore } from "../features/shell/settings";
import { useArtifactContent } from "../features/artifact/live";
import { useDrawerStore, detectEngineGate } from "../features/artifact/store";
import { exportThreadDownload } from "../features/retention/export";
import type { PaletteChat } from "../features/shell/CommandPalette";
import { useTheme } from "../features/shell/usetheme";
import { TitleBar, toggleMaximizeWindow } from "./TitleBar";

// Task 030: non-home views load on demand so first paint transforms the shell
// only. Overlays resolve behind a null fallback — they render nothing while
// closed anyway.
const ChatView = lazy(() =>
  import("../features/turn/ChatView").then((m) => ({ default: m.ChatView })),
);
const ProvidersView = lazy(() =>
  import("../features/providers/ProvidersView").then((m) => ({ default: m.ProvidersView })),
);
const ProjectsGrid = lazy(() =>
  import("../features/projects/ProjectsGrid").then((m) => ({ default: m.ProjectsGrid })),
);
const ProjectDetail = lazy(() =>
  import("../features/projects/ProjectDetail").then((m) => ({ default: m.ProjectDetail })),
);
const CommandPalette = lazy(() =>
  import("../features/shell/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const SettingsDialog = lazy(() =>
  import("../features/settings/SettingsDialog").then((m) => ({ default: m.SettingsDialog })),
);
const ArtifactDrawer = lazy(() =>
  import("../components/ArtifactDrawer").then((m) => ({ default: m.ArtifactDrawer })),
);

/** Skeleton for a lazily loading view (Task 030): layout-shaped, labelled. */
function ViewSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <div data-testid="view-skeleton" aria-label={label} className="flex h-full flex-col gap-3 p-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/**
 * Boot splash (Task 030): the shell's own shape in skeleton — titlebar bar,
 * rail, greeting block — instead of a bare text line, so first paint already
 * looks like the app while the runtime check + seed preload run behind it.
 */
function BootSkeleton({ error }: { error: string | null }): React.JSX.Element {
  return (
    <div data-testid="boot-skeleton" className="flex h-dvh w-screen min-w-[900px] flex-col bg-background">
      <span className="sr-only">Starting Clauro…</span>
      <div className="h-8 w-full border-b border-border">
        <Skeleton className="m-2 h-4 w-24" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[260px] flex-col gap-2 p-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-28 w-full max-w-[720px]" />
          {error !== null && (
            <p role="alert" className="max-w-[720px] text-center text-xs text-destructive">
              Boot error: {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const THREAD = "thread-001";

/** Threads rendered by the rail (Task 029 indicator wiring reads these ids). */
const THREADS_BY_PROJECT: Readonly<Record<string, readonly { id: string; title: string }[]>> = {
  default: [{ id: THREAD, title: "First thread" }],
};

const THREAD_IDS: readonly string[] = Object.values(THREADS_BY_PROJECT).flatMap((ts) =>
  ts.map((t) => t.id),
);

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
 * Fill the composer's draft through the store — the per-thread record is the
 * source of truth and Composer adopts external writes (review 30's DOM-
 * actuation NIT: no native setter, no synthetic `input` event). Focus follows
 * (html:368 `chip` action focuses the composer after filling); focus is a
 * viewport concern, not state, so it stays a direct DOM call.
 */
function fillComposerDraft(threadId: string, text: string): void {
  useThreadStore.getState().setComposerDraft(threadId, text);
  const box = document.querySelector('textarea[aria-label="Message"]');
  if (box instanceof HTMLTextAreaElement) box.focus();
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
  // Task 032 U2: App-owned UI state so every App-level button acts. Memory
  // rides here (Composer + rail read it, the toggle flips it); the new-project
  // dialog opens from the grid button and creates into `customProjects`
  // (real path only — the mock seed owns its projects). Declared before the
  // rail derivations + indicator memo below because both read them.
  // The Memory pane's persisted flag is this default (review 31: the pref had
  // zero readers): read on boot, written through on every toggle so the pane
  // and the shell can never disagree after a remount.
  const [memoryOff, setMemoryOff] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("clauro.memory.enabled") === "false";
    } catch {
      // Private-mode storage failure: default to enabled, never break boot.
      return false;
    }
  });
  function toggleMemory(): void {
    setMemoryOff((off) => {
      const next = !off;
      try {
        window.localStorage.setItem("clauro.memory.enabled", String(!next));
      } catch {
        // Best-effort persistence; the session state still flips.
      }
      return next;
    });
  }
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [customProjects, setCustomProjects] = useState<
    readonly { id: string; name: string; desc?: string; updatedAt?: string }[]
  >([]);
  // The thread on screen (Task 031 T8): home/new-chat targets THREAD, rail
  // selection targets the clicked id — the old code always rendered THREAD.
  const [activeThreadId, setActiveThreadId] = useState<string>(THREAD);
  const statusOf = useThreadStore((s) => s.statusOf);
  const running = useThreadStore((s) => s.running);
  const threadStates = useThreadStore((s) => s.threads);
  // Rail rows carry the session's store overrides (review 31 #1): rename and
  // pin win over the seed row, removed rows disappear everywhere the rail and
  // the palette render them. On the real path (no seed) the rail reflects the
  // thread store — opening a thread is what puts it on the rail, so the
  // row-menu actions act on rows the user can actually see.
  const railChats = useMemo<readonly RailThread[]>(() => {
    // The static project list owns the home thread's title ("First thread",
    // Task 031 T8); the store only supplies read-state and session overrides.
    // Deriving the row's title from the store instead dropped the home thread
    // back to the "New chat" placeholder whenever the store held no title.
    // (railThreadsByProject is declared further down, so its source expression
    // is inlined here to keep this memo free of a TDZ reference.)
    const threadsByProjectSource = mockSeed?.rail.threadsByProject ?? THREADS_BY_PROJECT;
    const knownTitle = (id: string): string | undefined => {
      for (const ts of Object.values(threadsByProjectSource)) {
        const hit = ts.find((t) => t.id === id);
        if (hit !== undefined) return hit.title;
      }
      return undefined;
    };
    const base: readonly RailThread[] =
      mockSeed?.rail.chats ??
      Object.entries(threadStates).flatMap(([id, st]) => {
        if (st === undefined) return [];
        return [
          {
            id,
            title: st.title ?? knownTitle(id) ?? "New chat",
            ...(st.updatedAt === 0 ? {} : { updated: st.updatedAt }),
            ...(st.pinned === null ? {} : { pinned: st.pinned }),
          },
        ];
      });
    return base
      .filter((row) => threadStates[row.id]?.removed !== true)
      .map((row) => {
        const st = threadStates[row.id];
        if (st === undefined) return row;
        return {
          ...row,
          title: st.title ?? row.title,
          ...(st.pinned === null ? {} : { pinned: st.pinned }),
        };
      });
    // railThreadsByProject below reads the same mockSeed/threadStates pair,
    // so its identity is stable across exactly these two inputs.
  }, [mockSeed, threadStates]);
  // Custom projects survive the mock seed landing (review 31 #16: the seed
  // list used to replace them wholesale).
  const railProjects = useMemo<
    readonly { id: string; name: string; desc?: string; updatedAt?: string }[]
  >(
    () => [
      ...(mockSeed?.rail.projects ?? DEMO_PROJECTS),
      ...customProjects,
    ],
    [mockSeed, customProjects],
  );
  // Review 31 #13: project rename/instructions land in a session-local edit
  // map — the seed and demo lists are read-only sources and no projects
  // store or Tauri command backs a durable write yet. Edits survive
  // navigation for the rest of the session; nothing touches disk.
  const [projectEdits, setProjectEdits] = useState<
    Partial<Record<string, { name?: string; instructions?: string }>>
  >({});
  // Every project surface (rail, palette, grid, detail, title bar) reads the
  // list through the edit map, so a rename lands everywhere at once.
  const projectList = useMemo(
    () =>
      railProjects.map((p) => {
        const name = projectEdits[p.id]?.name;
        return name === undefined || name === p.name ? p : { ...p, name };
      }),
    [railProjects, projectEdits],
  );
  const railThreadsByProject: Readonly<Record<string, readonly { id: string; title: string }[]>> =
    mockSeed?.rail.threadsByProject ?? THREADS_BY_PROJECT;
  // Indicator state for every rendered thread id (Task 029 B11) via the
  // store's `statusOf`. `statusOf` itself is a stable reference, so reactivity
  // comes from the `running`/`threads` slices; the map is memoized so the
  // selector identity stays stable (a fresh object per snapshot loops React).
  const statusByThread = useMemo<Record<string, ThreadStatus>>(() => {
    const out: Record<string, ThreadStatus> = {};
    // Rail rows, the static demo sub-threads, and the active thread (which
    // may be a fresh new-chat id absent from both lists — unknown reads idle
    // anyway) all get an indicator entry.
    const ids = new Set([...railChats.map((c) => c.id), ...THREAD_IDS, activeThreadId]);
    for (const id of ids) out[id] = statusOf(id);
    return out;
    // Reactive inputs are the `running` + `threads` slices subscribed above:
    // `statusOf` reads them from the store snapshot, so listing them here
    // invalidates the map exactly when indicator state can change.
    // `railChats` flips when the mock seed lands or overrides change.
    // `activeThreadId` covers fresh new-chat ids absent from the rail lists.
  }, [statusOf, running, threadStates, railChats, activeThreadId]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [view, setView] = useState<View>({ name: "home" });
  // The providers surface opens from three places (home button, rail gear,
  // settings CTA) — its state lives in the settings store so every opener,
  // including the dialog's own CTA, reaches the same surface (review 31 #14).
  const providersOpen = useSettingsStore((s) => s.providersOpen);
  const openProviders = useSettingsStore((s) => s.openProviders);
  const closeProviders = useSettingsStore((s) => s.closeProviders);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const displayName = useSettingsStore((s) => s.displayName);
  // Rail Export's outcome line (review 31): success names the file; a
  // blocked/failed export says why instead of failing silently.
  const [shellNotice, setShellNotice] = useState<string | null>(null);
  const artifactContent = useArtifactContent((s) => s.threads[activeThreadId]);
  // The engine gate rides the runtime verdict, not a hardcoded claim
  // (review 33: every caller hardcoded windows+proven). Derived per render,
  // identity-stable on the verdict: the 021 probe can record any time after
  // mount, so a mount-only memo would go stale.
  const gate = detectEngineGate();
  const engine = useMemo(
    () => ({ platform: gate.platform, opaqueProven: gate.opaqueProven }),
    [gate.platform, gate.opaqueProven],
  );
  // Review 32 (startup perf): React.lazy resolves on first render, so an
  // always-mounted overlay fetches its chunk at boot even though it renders
  // nothing while closed. Each overlay mounts on first need instead; the
  // latches never reset, so a reopen never re-suspends.
  const settingsOpen = useSettingsStore((s) => s.open);
  const [settingsEverOpened, setSettingsEverOpened] = useState(false);
  useEffect(() => {
    if (settingsOpen) setSettingsEverOpened(true);
  }, [settingsOpen]);
  const [paletteEverOpened, setPaletteEverOpened] = useState(false);
  useEffect(() => {
    if (paletteOpen) setPaletteEverOpened(true);
  }, [paletteOpen]);
  // The drawer mounts when there is drawer work: a non-empty row for this
  // thread (D121) or produced content. The D45 notice aside used to be a third
  // reason; D132 removed the only platform that could disable artifacts, so
  // there is no notice to keep on screen.
  const drawerEntry = useDrawerStore((s) => s.drawers[activeThreadId]);
  const drawerNeeded =
    (drawerEntry !== undefined && drawerEntry.state !== "empty") ||
    artifactContent !== null;
  // Delete-row confirmation (review 31 #1): destructive means confirm first.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  // Palette contents (review 31 #13): the same rail rows the shell renders,
  // overrides included, so a renamed chat shows its new title everywhere.
  const paletteChats = useMemo<readonly PaletteChat[]>(
    () => railChats.map((c) => ({ id: c.id, title: c.title })),
    [railChats],
  );

  // Rail Export shares the Settings → Data pipeline (review 31): same
  // key-material guard, same sanitised filename, typed outcome — success and
  // failure both land in the shell notice instead of vanishing.
  async function runExport(id: string): Promise<void> {
    const outcome = await exportThreadDownload(id, threadTitle(id) ?? "chat", "md");
    setShellNotice(
      outcome.ok
        ? `Exported ${String(outcome.blocks)} blocks as ${outcome.filename ?? "export"}.`
        : (outcome.error ?? "Export failed."),
    );
  }
  useSummonHotkey(() => {
    setPaletteOpen(true);
  });
  useSettingsHotkey(() => {
    openSettings("providers");
  });
  // Task 031 T6: every hotkey hook in hotkey.ts fires from the shell.
  // New chat creates a thread + opens the chat view (032 U2, same as the
  // rail New chat button) — never a baked-in id.
  useNewChatHotkey(() => {
    goNewChat();
  });
  // usePanelHotkey stays unwired on purpose: the artifact store has no drawer
  // open-state to toggle (empty/compiling/live per thread; empty renders
  // zero-width), so there is nothing for the hook to drive yet.
  // Compact is intent-only: the turn loop (023) owns dispatch — the same
  // event the palette's action:compact emits (CommandPalette.tsx).
  useCompactHotkey(() => {
    window.dispatchEvent(new CustomEvent("clauro:compact-request"));
  });
  // TitleBar's module-level toggle (same handler the caption button uses) —
  // no DOM query, no duplicated Tauri logic (review 30 NIT).
  useMaximizeHotkey(() => {
    void toggleMaximizeWindow();
  });

  // Palette intents (review 31 #2): the palette cannot navigate — this shell
  // owns `view` — so New chat / chat entries / project entries dispatch
  // events and only here do they change what is on screen. The handlers touch
  // stable store setters only, so a mount-time registration is safe.
  useEffect(() => {
    const onOpenChat = (e: Event): void => {
      // Runtime `detail` is null for a bare CustomEvent even though the DOM
      // types say otherwise, so the cast keeps null in the type.
      const detail = (e as CustomEvent<{ threadId?: string } | null>).detail;
      const id = detail?.threadId;
      if (id === undefined) goNewChat();
      else openThreadView(id);
    };
    const onOpenProject = (e: Event): void => {
      const id = (e as CustomEvent<{ id?: string } | null>).detail?.id;
      if (id !== undefined) setView({ name: "project", id });
    };
    window.addEventListener("clauro:open-chat", onOpenChat);
    window.addEventListener("clauro:open-project", onOpenProject);
    return () => {
      window.removeEventListener("clauro:open-chat", onOpenChat);
      window.removeEventListener("clauro:open-project", onOpenProject);
    };
    // Mount-time on purpose: goNewChat/openThreadView only touch stable store
    // setters and state setters, so the first-render closures stay correct;
    // re-subscribing per render would re-bind the window listeners every
    // frame. (No deps-lint rule is registered in this config.)
  }, []);

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
        // Preload the two most likely next chunks while the user reads home
        // (Task 030): chat view + settings resolve in the background, so
        // opening them later never pays a transform. Fire-and-forget by
        // design — failures surface when the view actually opens.
        if (typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(() => {
            void import("../features/turn/ChatView");
            void import("../features/settings/SettingsDialog");
          });
        }
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
    return <BootSkeleton error={error} />;
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

  const project =
    view.name === "project" ? projectList.find((p) => p.id === view.id) : undefined;
  const detailBase =
    view.name === "project" && project ? mockDetailProps(mockSeed?.rail ?? null, project.id) : null;
  const savedInstructions =
    project === undefined ? undefined : projectEdits[project.id]?.instructions;
  const detail =
    detailBase === null || savedInstructions === undefined
      ? detailBase
      : { ...detailBase, instructions: savedInstructions };
  const title =
    view.name === "chat"
      ? (threadTitle(activeThreadId) ?? "New chat")
      : view.name === "project"
        ? (project?.name ?? "Project")
        : view.name === "projects"
          ? "Projects"
          : undefined;

  function threadTitle(id: string): string | undefined {
    // Store override (review 31 #1) beats whichever list owns the row.
    const override = threadStates[id]?.title;
    if (override != null) return override;
    const flat = railChats.find((t) => t.id === id)?.title;
    if (flat !== undefined) return flat;
    for (const ts of Object.values(railThreadsByProject)) {
      const hit = ts.find((t) => t.id === id)?.title;
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  // Home send routes through the thread store (it owns threads) into the
  // chat view. The turn loop (023) owns dispatch from there; the old `noop`
  // dead-end is gone. Ctrl+N rides the same path (useNewChatHotkey above).
  function goChat(): void {
    openThread(THREAD);
    setActiveThreadId(THREAD);
    if (isMockMode()) {
      useThreadStore.getState().markUpdated(THREAD, Date.now());
    }
    setView({ name: "chat" });
  }

  // New chat (Task 032 U2): creation IS openThread with a fresh id — the
  // store has no separate createThread semantics, and openThread always
  // materialises the row. Title resolves to "New chat" via the threadTitle
  // fallback until the turn loop (023) owns titles.
  function goNewChat(): void {
    const id = crypto.randomUUID();
    openThread(id);
    setActiveThreadId(id);
    if (isMockMode()) {
      useThreadStore.getState().markUpdated(id, Date.now());
    }
    setView({ name: "chat" });
  }

  function openThreadView(id: string): void {
    openThread(id);
    setActiveThreadId(id);
    // Viewed-on-open (Task 029 B11): the click is the signal. openThread
    // above guarantees existence, so markRead cannot throw here.
    markRead(id, Date.now());
    setView({ name: "chat" });
  }

  function handleHomeSend(text: string): void {
    // The home composer unmounts on navigation — stage its text so the chat
    // view sends it once on mount instead of dropping it (Task 031 T8).
    if (text.trim() !== "") {
      openThread(THREAD);
      useThreadStore.getState().setDraft(THREAD, text);
    }
    goChat();
  }

  return (
    <div className="flex h-dvh w-screen min-w-[900px] flex-col overflow-hidden bg-background font-sans text-sm text-foreground">
      <TitleBar title={title} />
      {shellNotice !== null && (
        <p
          role="status"
          data-testid="shell-notice"
          className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
        >
          {shellNotice}
        </p>
      )}
      {paletteEverOpened && (
        <Suspense fallback={null}>
          <CommandPalette
            state={{ turnRunning: running.length > 0 }}
            open={paletteOpen}
            chats={paletteChats}
            projects={projectList}
          />
        </Suspense>
      )}
      {settingsEverOpened && (
        <Suspense fallback={null}>
          <SettingsDialog threadId={activeThreadId} title={title ?? "New chat"} />
        </Suspense>
      )}
      {/* Rail Delete confirms first (review 31 #1); the override is
          session-local until a host `delete_thread` command exists (thread.ts). */}
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <DialogContent aria-label="Delete chat" className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-sm">Delete chat?</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {pendingDelete?.title ?? "This chat"} disappears from the rail for the rest of this
            session. Nothing on disk is touched yet.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setPendingDelete(null);
              }}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="delete-thread-confirm"
              onClick={() => {
                if (pendingDelete !== null) {
                  useThreadStore.getState().removeThread(pendingDelete.id);
                }
                setPendingDelete(null);
              }}
              className="rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-accent"
            >
              Delete
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={providersOpen}
        onOpenChange={(next) => {
          if (!next) closeProviders();
        }}
      >
        <DialogContent
          aria-label="Providers"
          className="h-[min(640px,calc(100dvh-2rem))] w-[min(960px,calc(100vw-2rem))] max-w-none gap-0 overflow-y-auto p-4 sm:max-w-[min(960px,calc(100vw-2rem))]"
        >
          <DialogHeader className="pb-2 text-left">
            <DialogTitle className="text-sm">Providers</DialogTitle>
          </DialogHeader>
          <Suspense fallback={null}>
            <ProvidersView />
          </Suspense>
        </DialogContent>
      </Dialog>
      <div className="flex min-h-0 flex-1 items-stretch gap-0">
        {/* Shrink-0 shell only: the rail sets its own width (260px open,
            48px collapsed) from SidebarProvider state, so this wrapper must
            size to content, never pin it. Pinning it was the bug that crushed
            the center column to zero (proven in-browser 2026-10-07). */}
        <div className="shrink-0 self-stretch overflow-hidden">
          <ProjectsRail
            projects={projectList}
            memoryOff={memoryOff}
            threadsByProject={railThreadsByProject}
            chats={railChats}
            now={mockSeed?.now}
            statusByThread={statusByThread}
            activeThreadId={activeThreadId}
            onSelectProject={(id) => {
              setView({ name: "project", id });
            }}
            onSelectThread={(id) => {
              openThreadView(id);
            }}
            onNewChat={() => {
              goNewChat();
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
            onPinThread={(id, pinned) => {
              // Session-local override (thread.ts): no host command yet, so
              // the pin lives in the store and rides the railChats derivation.
              useThreadStore.getState().setPinned(id, pinned);
            }}
            onRenameThread={(id, nextTitle) => {
              useThreadStore.getState().renameThread(id, nextTitle);
            }}
            onExportThread={(id) => {
              void runExport(id);
            }}
            onDeleteThread={(id) => {
              setPendingDelete({ id, title: threadTitle(id) ?? "chat" });
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
                    memoryOff={memoryOff}
                    onSend={handleHomeSend}
                    onMemoryToggle={toggleMemory}
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
                        fillComposerDraft(activeThreadId, suggestion);
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
                      openProviders();
                    }}
                  >
                    Providers
                  </button>
                </div>
              </div>
            </div>
          )}
          {view.name === "projects" && (
            <Suspense fallback={<ViewSkeleton label="Loading projects" />}>
              <ProjectsGrid
                projects={projectList}
                chatCountByProject={mockSeed?.rail.chatCountByProject}
                onNew={() => {
                  setProjectDialogOpen(true);
                }}
                onOpen={(id) => {
                  setView({ name: "project", id });
                }}
                dialogOpen={projectDialogOpen}
                onDialogChange={setProjectDialogOpen}
                onCreate={(input) => {
                  setCustomProjects((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      name: input.name,
                      ...(input.desc === "" ? {} : { desc: input.desc }),
                    },
                  ]);
                }}
              />
            </Suspense>
          )}
          {view.name === "project" && project && detail && (
            <Suspense fallback={<ViewSkeleton label="Loading project" />}>
              <ProjectDetail
                project={project}
                instructions={detail.instructions}
                memoryCount={0}
                contextUsed="0%"
                chats={detail.chats}
                files={detail.files}
                onRename={(name) => {
                  setProjectEdits((prev) => ({
                    ...prev,
                    [project.id]: { ...prev[project.id], name },
                  }));
                }}
                onSaveInstructions={(text) => {
                  setProjectEdits((prev) => ({
                    ...prev,
                    [project.id]: { ...prev[project.id], instructions: text },
                  }));
                }}
                onOpenChat={(id) => {
                  openThreadView(id);
                }}
                onStartChat={(message) => {
                  // The detail composer unmounts on navigation — stage its
                  // text like home send does, on a fresh thread (032 U2).
                  const id = crypto.randomUUID();
                  openThread(id);
                  useThreadStore.getState().setDraft(id, message);
                  setActiveThreadId(id);
                  if (isMockMode()) {
                    useThreadStore.getState().markUpdated(id, Date.now());
                  }
                  setView({ name: "chat" });
                }}
                onBack={() => {
                  setView({ name: "projects" });
                }}
              />
            </Suspense>
          )}
          {view.name === "chat" && (
            <div data-testid="chat-pane" className="flex h-full min-h-0 flex-col">
              <Suspense fallback={<ViewSkeleton label="Loading chat" />}>
                <ChatView threadId={activeThreadId} />
              </Suspense>
            </div>
          )}
        </div>
        {/* Engine gate is prop-driven: the shell passes the real verdict once
            the Tauri runtime check exists (021). Windows-verified is the dev
            default per AGENTS.md §8a. The artifact content rides the
            producer's store (D121); empty means nothing has been produced. */}
        {drawerNeeded && (
          <Suspense fallback={null}>
            <ArtifactDrawer
              threadId={activeThreadId}
              engine={engine}
              source={artifactContent?.source ?? ""}
              mediaType={artifactContent?.mediaType ?? "text/html"}
              title={artifactContent?.title ?? ""}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
