import { Brain } from "lucide-react";
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
      {memoryOff ? (
        <span aria-label="memory off" className="text-neutral-500">
          <Brain size={16} strokeWidth={1.75} />
        </span>
      ) : null}
      </Sidebar>
    </SidebarProvider>
  );
}
