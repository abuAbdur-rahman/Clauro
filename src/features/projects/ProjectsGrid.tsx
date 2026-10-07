import { useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Project } from "./projects";

export function ProjectsGrid({
  projects,
  onNew,
  onOpen,
}: {
  projects: readonly Project[];
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const visible = projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-serif text-2xl text-neutral-100">Projects</h1>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Search projects"
            placeholder="Search projects"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
            }}
            className="w-48"
          />
          <Button onClick={onNew}>New project</Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {visible.map((p) => (
          <Card key={p.id}>
            <CardHeader>
              <CardTitle>
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => {
                    onOpen(p.id);
                  }}
                >
                  {p.name}
                </button>
              </CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
