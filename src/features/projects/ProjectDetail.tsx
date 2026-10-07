import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Project } from "./projects";

export function ProjectDetail({
  project,
  instructions,
  memoryCount,
  contextUsed,
  onBack,
}: {
  project: Project;
  instructions: string;
  memoryCount: number;
  contextUsed: string;
  onBack: () => void;
}) {
  return (
    <div>
      <nav aria-label="breadcrumb" className="mb-4 text-sm text-neutral-400">
        <button type="button" className="hover:underline" onClick={onBack}>
          Projects
        </button>
        <span aria-hidden="true"> / </span>
        <span className="text-neutral-100">{project.name}</span>
      </nav>
      <div className="flex gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-2xl text-neutral-100">{project.name}</h1>
        </div>
        <aside className="w-72 space-y-4" aria-label="project context">
          <Card>
            <CardHeader>
              <CardTitle>Instructions</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-neutral-400">{instructions || "No instructions yet."}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Memory</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-neutral-400">
                {memoryCount} {memoryCount === 1 ? "topic" : "topics"} kept for this project.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Context</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-neutral-400">
                <span className="text-neutral-100">{contextUsed}</span> of project capacity used
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
