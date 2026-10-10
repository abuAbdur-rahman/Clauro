/**
 * Projects rail on the vendored shadcn Sidebar (Tasks/018 + 025, D112,
 * UI-GUIDE §6). Header (collapse), nav actions (New chat, Search,
 * Projects), PROJECTS group with nested threads, date-grouped chat list
 * (PINNED / TODAY / YESTERDAY / PREVIOUS 7 DAYS / OLDER, sticky headers),
 * footer with settings gear + profile menu.
 *
 * Date grouping is a pure port of the prototype `groupChats`
 * (docs/references/ui/index.html:370) and the mock seed
 * (`src/mock/seed.ts`). It lives here — not in `@/mock/*` — so the real
 * shell stays mock-free (shell.mockmode.test.ts). `groupRailChats` is
 * exported for unit tests; it operates on `RailThread`, never on seed
 * types.
 *
 * Thread status indicator (Task 029): each thread row carries
 * `data-testid="thread-row-{id}"` + `data-status="working|done|not-viewed|idle"`.
 * `working` pulses (spinner role); `done` accent dot + semibold; `not-viewed`
 * hollow dot; idle none. `onSelectThread` marks viewed-on-open (caller owns
 * `lastReadAt`; the click is the signal).
 */
import { useState } from "react";
import {
  Brain,
  Ellipsis,
  FolderKanban,
  MessageSquare,
  PanelLeft,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Project } from "./projects";
import type { ThreadStatus } from "@/features/catalogue/thread";

export interface RailThread {
  id: string;
  title: string;
  /** Owning project id; null/undefined = no project (no color dot). */
  projectId?: string | null;
  /** Last activity, ms epoch or ISO string. Absent = treated as now. */
  updated?: number | string;
  pinned?: boolean;
}

export const DAY_MS = 86_400_000;

/** Project color wheel ported from the prototype `PCOL` (index.html:335). */
export const PROJECT_COLORS = ["#c96442", "#0067c0", "#0f7b0f", "#7a42d6", "#c239b3"] as const;

export type ChatGroupLabel = "PINNED" | "TODAY" | "YESTERDAY" | "PREVIOUS 7 DAYS" | "OLDER";

const GROUP_ORDER: readonly ChatGroupLabel[] = [
  "PINNED",
  "TODAY",
  "YESTERDAY",
  "PREVIOUS 7 DAYS",
  "OLDER",
];

export function projectColor(
  projectId: string | null | undefined,
  projects: readonly Project[],
): string | undefined {
  if (projectId === null || projectId === undefined) return undefined;
  const i = projects.findIndex((p) => p.id === projectId);
  if (i < 0) return undefined;
  return PROJECT_COLORS[i % PROJECT_COLORS.length];
}

function updatedMs(updated: number | string | undefined, now: number): number {
  if (typeof updated === "number") return updated;
  if (typeof updated === "string") {
    const t = Date.parse(updated);
    return Number.isNaN(t) ? now : t;
  }
  return now;
}

/**
 * Pure date-grouping port of prototype `groupChats` (index.html:370).
 * Sorts newest-first; pinned threads always land in PINNED. Empty buckets
 * are omitted, order is fixed PINNED → OLDER.
 */
export function groupRailChats(
  chats: readonly RailThread[],
  now: number = Date.now(),
): Array<[ChatGroupLabel, RailThread[]]> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const start = startOfToday.getTime();
  const groups: Record<ChatGroupLabel, RailThread[]> = {
    PINNED: [],
    TODAY: [],
    YESTERDAY: [],
    "PREVIOUS 7 DAYS": [],
    OLDER: [],
  };
  [...chats]
    .sort((a, b) => updatedMs(b.updated, now) - updatedMs(a.updated, now))
    .forEach((c) => {
      if (c.pinned === true) {
        groups.PINNED.push(c);
        return;
      }
      const t = updatedMs(c.updated, now);
      const bucket: ChatGroupLabel =
        t >= start
          ? "TODAY"
          : t >= start - DAY_MS
            ? "YESTERDAY"
            : t >= start - 7 * DAY_MS
              ? "PREVIOUS 7 DAYS"
              : "OLDER";
      groups[bucket].push(c);
    });
  return GROUP_ORDER.map(
    (label): [ChatGroupLabel, RailThread[]] => [label, groups[label]],
  ).filter(([, rows]) => rows.length > 0);
}

interface ProjectsRailProps {
  projects: readonly Project[];
  memoryOff: boolean;
  threadsByProject?: Readonly<Record<string, readonly RailThread[]>>;
  /**
   * Flat chat rows from the real thread store. When provided, the
   * date-grouped list renders from these; otherwise it flattens
   * `threadsByProject` (same rows, `projectId` taken from the map key).
   * The props contract is unchanged — this is additive.
   */
  chats?: readonly RailThread[];
  activeProjectId?: string | null;
  activeThreadId?: string | null;
  /** Task 029 indicator: thread id → working|done|not-viewed|idle. Absent = idle. */
  statusByThread?: Readonly<Record<string, ThreadStatus>>;
  /** Footer identity. Defaults match the mock seed user. */
  userName?: string;
  userPlan?: string;
  /** Reference clock for date grouping (tests inject; default now). */
  now?: number;
  onSelectProject?: (id: string) => void;
  onSelectThread?: (id: string) => void;
  onNewChat?: () => void;
  onSearch?: () => void;
  onOpenProjects?: () => void;
  onOpenSettings?: () => void;
  onPinThread?: (id: string, pinned: boolean) => void;
  onRenameThread?: (id: string, title: string) => void;
  onMoveThread?: (id: string, projectId: string | null) => void;
  onExportThread?: (id: string) => void;
  onDeleteThread?: (id: string) => void;
  onOpenShortcuts?: () => void;
  onOpenHelp?: () => void;
  onSignOut?: () => void;
}

export function ProjectsRail(props: ProjectsRailProps): React.JSX.Element {
  return (
    // Constrain the provider to the rail box: its built-in `min-h-svh`
    // would otherwise grow with long chat lists and push the footer below
    // the fold (the html truth keeps the footer pinned with an internal
    // scroll). `min-h-0!` wins over `min-h-svh` via !important.
    <SidebarProvider className="h-full min-h-0! w-auto">
      <RailBody {...props} />
    </SidebarProvider>
  );
}

function StatusDot({ status }: { status: ThreadStatus }): React.JSX.Element | null {
  if (status === "idle") return null;
  if (status === "working") {
    return (
      <span
        role="status"
        aria-label="thread working"
        className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary"
      />
    );
  }
  if (status === "done") {
    return <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-primary" />;
  }
  return (
    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground" />
  );
}

function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  return trimmed.slice(0, 2).toUpperCase();
}

function RailBody(props: ProjectsRailProps): React.JSX.Element {
  const {
    projects,
    memoryOff,
    threadsByProject = {},
    chats,
    activeProjectId = null,
    activeThreadId = null,
    statusByThread = {},
    userName = "Abu",
    userPlan = "BYOK · Free",
    now,
    onSelectProject = () => {},
    onSelectThread = () => {},
    onNewChat = () => {},
    onSearch = () => {},
    onOpenProjects = () => {},
    onOpenSettings = () => {},
    onPinThread = () => {},
    onRenameThread = () => {},
    onMoveThread = () => {},
    onExportThread = () => {},
    onDeleteThread = () => {},
    onOpenShortcuts,
    onOpenHelp,
    onSignOut,
  } = props;
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");

  const flat: readonly RailThread[] =
    chats ??
    Object.entries(threadsByProject).flatMap(([projectId, threads]) =>
      threads.map((t) => ({ ...t, projectId })),
    );
  const groups = groupRailChats(flat, now);

  const beginRename = (thread: RailThread): void => {
    setRenamingId(thread.id);
    setRenameDraft(thread.title);
  };
  const cancelRename = (): void => {
    setRenamingId(null);
    setRenameDraft("");
  };
  const saveRename = (id: string): void => {
    const title = renameDraft.trim();
    if (title.length > 0) onRenameThread(id, title);
    setRenamingId(null);
    setRenameDraft("");
  };

  const renderRowMenu = (thread: RailThread): React.JSX.Element => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Options for ${thread.title}`}
          data-testid={`thread-menu-${thread.id}`}
          onClick={(e) => {
            e.stopPropagation();
          }}
          // Hidden until hover/focus/open like the prototype `.more` button
          // (index.html:84): unconditional opacity-0, not the md: breakpoint
          // variant, so narrow windows behave the same as wide ones.
          className="absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground opacity-0 outline-hidden transition-opacity hover:bg-sidebar-accent focus-visible:opacity-100 focus-visible:ring-2 group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100 data-[state=open]:opacity-100"
        >
          <Ellipsis size={16} strokeWidth={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom">
        <DropdownMenuItem
          onSelect={() => {
            onPinThread(thread.id, !(thread.pinned === true));
          }}
        >
          {thread.pinned === true ? "Unpin" : "Pin"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            beginRename(thread);
          }}
        >
          Rename
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move to project</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onSelect={() => {
                onMoveThread(thread.id, null);
              }}
            >
              No project
            </DropdownMenuItem>
            {projects.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onSelect={() => {
                  onMoveThread(thread.id, p.id);
                }}
              >
                {p.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          onSelect={() => {
            onExportThread(thread.id);
          }}
        >
          Export
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            onDeleteThread(thread.id);
          }}
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderGroupedRow = (thread: RailThread): React.JSX.Element => {
    const status = statusByThread[thread.id] ?? "idle";
    const isActive = thread.id === activeThreadId;
    const color = projectColor(thread.projectId, projects);
    if (renamingId === thread.id) {
      return (
        <SidebarMenuItem key={thread.id}>
          <div className="relative">
            <input
              autoFocus
              aria-label="Rename chat"
              data-testid={`rename-input-${thread.id}`}
              value={renameDraft}
              onChange={(e) => {
                setRenameDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveRename(thread.id);
                if (e.key === "Escape") cancelRename();
              }}
              onBlur={() => {
                saveRename(thread.id);
              }}
              className="h-8 w-full rounded-md border border-primary bg-background px-2 text-sm outline-hidden"
            />
          </div>
        </SidebarMenuItem>
      );
    }
    return (
      <SidebarMenuItem key={thread.id}>
        <div className="relative">
          {isActive && (
            <span
              aria-hidden="true"
              data-testid={`thread-accent-${thread.id}`}
              className="absolute top-2 bottom-2 left-0 z-10 w-[3px] rounded-full bg-primary"
            />
          )}
          <SidebarMenuButton
            data-testid={`thread-row-${thread.id}`}
            data-status={status}
            tooltip={thread.title}
            aria-label={collapsed ? thread.title : undefined}
            isActive={isActive}
            onClick={() => {
              onSelectThread(thread.id);
            }}
            className="pr-8"
          >
            {collapsed ? (
              <MessageSquare size={16} strokeWidth={1.75} />
            ) : (
              <>
                {color !== undefined && (
                  <span
                    aria-hidden="true"
                    title={projects.find((p) => p.id === thread.projectId)?.name}
                    data-testid={`thread-dot-${thread.id}`}
                    style={{ backgroundColor: color }}
                    className="h-2 w-2 shrink-0 rounded-full"
                  />
                )}
                <span
                  className={`truncate ${status === "done" ? "font-semibold" : ""}`}
                >
                  {thread.title}
                </span>
                <StatusDot status={status} />
              </>
            )}
          </SidebarMenuButton>
          {!collapsed && renderRowMenu(thread)}
        </div>
      </SidebarMenuItem>
    );
  };

  return (
    <div
      data-testid="projects-rail"
      className={`${collapsed ? "w-14" : "w-[260px]"} h-full min-h-0 shrink-0 self-stretch overflow-hidden transition-[width] duration-200`}
    >
      <Sidebar collapsible="none" className="h-full w-full">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1">
            <span className="flex-1" />
            <button
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={toggleSidebar}
              className="rounded-md p-1.5 text-sidebar-foreground hover:bg-sidebar-accent"
            >
              <PanelLeft size={16} strokeWidth={1.75} />
            </button>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <nav aria-label="projects">
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip="New chat"
                      aria-label={collapsed ? "New chat" : undefined}
                      onClick={onNewChat}
                      className="bg-primary font-medium text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground data-[active=true]:bg-primary data-[active=true]:text-primary-foreground"
                    >
                      <Plus size={16} strokeWidth={1.75} />
                      {!collapsed && (
                        <>
                          <span>New chat</span>
                          <kbd
                            aria-hidden="true"
                            className="ml-auto rounded border border-primary-foreground/40 px-1 text-xs opacity-80"
                          >
                            Ctrl+N
                          </kbd>
                        </>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip="Search"
                      aria-label={collapsed ? "Search" : undefined}
                      onClick={onSearch}
                    >
                      <Search size={16} strokeWidth={1.75} />
                      {!collapsed && <span>Search</span>}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip="Projects"
                      aria-label={collapsed ? "Projects" : undefined}
                      onClick={onOpenProjects}
                    >
                      <FolderKanban size={16} strokeWidth={1.75} />
                      {!collapsed && <span>Projects</span>}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              {!collapsed && <SidebarGroupLabel>Projects</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {projects.map((p) => (
                    <SidebarMenuItem key={p.id}>
                      <SidebarMenuButton
                        tooltip={p.name}
                        aria-label={collapsed ? p.name : undefined}
                        isActive={p.id === activeProjectId}
                        onClick={() => {
                          onSelectProject(p.id);
                        }}
                      >
                        <FolderKanban size={16} strokeWidth={1.75} />
                        {!collapsed && <span className="truncate">{p.name}</span>}
                      </SidebarMenuButton>
                      {!collapsed && (
                        <SidebarMenuSub>
                          {(threadsByProject[p.id] ?? []).map((t) => (
                            <SidebarMenuSubItem key={t.id}>
                              <SidebarMenuSubButton
                                data-testid={`thread-sub-${t.id}`}
                                data-status={statusByThread[t.id] ?? "idle"}
                                isActive={t.id === activeThreadId}
                                onClick={() => {
                                  onSelectThread(t.id);
                                }}
                              >
                                <StatusDot status={statusByThread[t.id] ?? "idle"} />
                                <span className="truncate">{t.title}</span>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      )}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            {groups.map(([label, rows]) => (
              <SidebarGroup key={label}>
                {!collapsed && (
                  <div
                    data-testid={`chat-group-${label}`}
                    className="sticky top-0 z-10 bg-sidebar px-2 pt-2.5 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {label}
                  </div>
                )}
                <SidebarGroupContent>
                  <SidebarMenu>
                    {rows.map((t) => renderGroupedRow(t))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </nav>
        </SidebarContent>
        <SidebarFooter>
          <div className="flex items-center gap-1 border-t border-sidebar-border pt-2">
            <button
              type="button"
              data-testid="settings-button"
              aria-label="Settings"
              title="Settings"
              onClick={onOpenSettings}
              className="flex aspect-square w-8 shrink-0 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-hidden hover:bg-sidebar-accent focus-visible:ring-2"
            >
              <Settings size={16} strokeWidth={1.75} />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="profile-menu"
                  aria-label={collapsed ? `${userName}, ${userPlan}` : "Profile"}
                  title="Profile"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left outline-hidden hover:bg-sidebar-accent focus-visible:ring-2"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                  >
                    {initialsOf(userName)}
                  </span>
                  {!collapsed && (
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate text-sm font-medium">{userName}</span>
                      <span className="truncate text-xs text-muted-foreground">{userPlan}</span>
                    </span>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuItem
                  onSelect={() => {
                    onOpenSettings();
                  }}
                >
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={onOpenShortcuts === undefined}
                  title={
                    onOpenShortcuts === undefined
                      ? "Not wired yet: shortcuts dialog has no owner"
                      : undefined
                  }
                  onSelect={() => {
                    onOpenShortcuts?.();
                  }}
                >
                  Shortcuts
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={onOpenHelp === undefined}
                  title={
                    onOpenHelp === undefined ? "Not wired yet: help has no owner" : undefined
                  }
                  onSelect={() => {
                    onOpenHelp?.();
                  }}
                >
                  Help
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={onSignOut === undefined}
                  title={onSignOut === undefined ? "Not wired yet: no auth owner" : undefined}
                  onSelect={() => {
                    onSignOut?.();
                  }}
                >
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {memoryOff && (
            <span aria-label="memory off" className="p-2 text-neutral-500">
              <Brain size={16} strokeWidth={1.75} />
            </span>
          )}
        </SidebarFooter>
      </Sidebar>
    </div>
  );
}
