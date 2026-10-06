import { Sidebar, SidebarProvider } from "@/components/ui/sidebar";
import type { Project } from "./projects";

export function ProjectsRail({
  projects,
  memoryOff,
}: {
  projects: readonly Project[];
  memoryOff: boolean;
}) {
  return (
    <SidebarProvider>
      <Sidebar>
      <nav aria-label="projects">
        {projects.map((p) => (
          <div key={p.id}>{p.name}</div>
        ))}
      </nav>
      {memoryOff ? <span aria-label="memory off">✕🧠</span> : null}
      </Sidebar>
    </SidebarProvider>
  );
}
