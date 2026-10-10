/**
 * Projects rail on the vendored shadcn Sidebar (Tasks/018 + 025, D112,
 * UI-GUIDE §6). Header (wordmark + collapse), nav actions (New chat, Search,
 * Projects), PROJECTS group with nested threads, RECENT group, footer with
 * Settings. Rows are SidebarMenuButtons — never raw text. Collapses to a
 * 48px icon rail; labels hide, tooltips take over.
 *
 * No hand-rolled collapse: open state lives in SidebarProvider (cookie),
 * and the wrapper width follows it (260px open, 56px collapsed).
 *
 * Thread status indicator (Task 029): each thread row carries
 * `data-testid="thread-row-{id}"` + `data-status="working|done|not-viewed|idle"`.
 * `working` pulses (spinner role); `done` accent dot + semibold; `not-viewed`
 * hollow dot; idle none. `onSelectThread` marks viewed-on-open (caller owns
 * `lastReadAt`; the click is the signal).
 */
import { Brain, FolderKanban, MessageSquare, PanelLeft, Plus, Search, Settings } from "lucide-react";
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
import type { Project } from "./projects";
import type { ThreadStatus } from "@/mock/seed";

export interface RailThread {
  id: string;
  title: string;
}

interface ProjectsRailProps {
  projects: readonly Project[];
  memoryOff: boolean;
  threadsByProject?: Readonly<Record<string, readonly RailThread[]>>;
  activeProjectId?: string | null;
  activeThreadId?: string | null;
  /** Task 029 indicator: thread id → working|done|not-viewed|idle. Absent = idle. */
  statusByThread?: Readonly<Record<string, ThreadStatus>>;
  onSelectProject?: (id: string) => void;
  onSelectThread?: (id: string) => void;
  onNewChat?: () => void;
  onSearch?: () => void;
  onOpenProjects?: () => void;
  onOpenSettings?: () => void;
}

export function ProjectsRail(props: ProjectsRailProps): React.JSX.Element {
  return (
    <SidebarProvider>
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

function RailBody(props: ProjectsRailProps): React.JSX.Element {
  const {
    projects,
    memoryOff,
    threadsByProject = {},
    activeProjectId = null,
    activeThreadId = null,
    statusByThread = {},
    onSelectProject = () => {},
    onSelectThread = () => {},
    onNewChat = () => {},
    onSearch = () => {},
    onOpenProjects = () => {},
    onOpenSettings = () => {},
  } = props;
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const recent: { projectId: string; thread: RailThread }[] = [];
  for (const p of projects) {
    for (const t of threadsByProject[p.id] ?? []) {
      if (recent.length < 5) recent.push({ projectId: p.id, thread: t });
    }
  }

  return (
    <div
      data-testid="projects-rail"
      className={`${collapsed ? "w-14" : "w-[260px]"} h-full min-h-0 shrink-0 self-stretch overflow-hidden transition-[width] duration-200`}
    >
      <Sidebar collapsible="none" className="h-full w-full">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1">
            {!collapsed && (
              <span className="truncate text-sm font-semibold text-sidebar-foreground">
                Clauro
              </span>
            )}
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
                  >
                    <Plus size={16} strokeWidth={1.75} />
                    {!collapsed && <span>New chat</span>}
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
          {recent.length > 0 && (
            <SidebarGroup>
              {!collapsed && <SidebarGroupLabel>Recent</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {recent.map(({ thread: t }) => (
                    <SidebarMenuItem key={t.id}>
                      <SidebarMenuButton
                        data-testid={`thread-row-${t.id}`}
                        data-status={statusByThread[t.id] ?? "idle"}
                        tooltip={t.title}
                        aria-label={collapsed ? t.title : undefined}
                        isActive={t.id === activeThreadId}
                        onClick={() => {
                          onSelectThread(t.id);
                        }}
                      >
                        <MessageSquare size={16} strokeWidth={1.75} />
                        {!collapsed && (
                          <span className={`truncate ${(statusByThread[t.id] ?? "idle") === "done" ? "font-semibold" : ""}`}>
                            {t.title}
                          </span>
                        )}
                        {!collapsed && <StatusDot status={statusByThread[t.id] ?? "idle"} />}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          </nav>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Settings" aria-label={collapsed ? "Settings" : undefined} onClick={onOpenSettings}>
                <Settings size={16} strokeWidth={1.75} />
                {!collapsed && <span>Settings</span>}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
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
