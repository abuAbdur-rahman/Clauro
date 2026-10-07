import { Sidebar, SidebarProvider } from "@/components/ui/sidebar";
import type { Project } from "./projects";

export function ProjectsRail({
  projects,
  memoryOff,
  threadsByProject = {},
  onSelectProject = () => {},
  onSelectThread = () => {},
}: {
  projects: readonly Project[];
  memoryOff: boolean;
  threadsByProject?: Readonly<Record<string, readonly { id: string; title: string }[]>>;
  onSelectProject?: (id: string) => void;
  onSelectThread?: (id: string) => void;
}) {
  return (
    <SidebarProvider>
      <Sidebar>
      <nav aria-label="projects">
        {projects.map((p) => (
          <div key={p.id}>
            <button
              type="button"
              onClick={() => {
                onSelectProject(p.id);
              }}
            >
              {p.name}
            </button>
            <ul aria-label={`${p.name} threads`}>
              {(threadsByProject[p.id] ?? []).map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectThread(t.id);
                    }}
                  >
                    {t.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {memoryOff ? <span aria-label="memory off">✕🧠</span> : null}
      </Sidebar>
    </SidebarProvider>
  );
}
