import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Project } from "./projects";
import {
  formatChatCount,
  formatProjectUpdated,
  projectDescription,
  projectDotColor,
} from "./projects";

export interface NewProjectInput {
  name: string;
  desc: string;
}

/**
 * New-project dialog (Radix). Inline validation: name is required.
 * Wiring to the store belongs to the App owner — this only exposes the props.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: NewProjectInput) => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setDesc("");
      setError(null);
    }
  }, [open ]);

  function submit(): void {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Name is required");
      return;
    }
    onCreate({ name: trimmed, desc: desc.trim() });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-project-dialog" aria-label="New project">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Projects scope memory, files, and chats.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="np-name">Name</Label>
            <Input
              id="np-name"
              data-testid="project-name-input"
              value={name}
              aria-invalid={error !== null}
              onChange={(e) => {
                setName(e.target.value);
                if (error !== null && e.target.value.trim() !== "") setError(null);
              }}
            />
            {error !== null && (
              <p data-testid="project-name-error" role="alert" className="text-sm text-red-400">
                {error}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="np-desc">Description</Label>
            <Input
              id="np-desc"
              data-testid="project-desc-input"
              value={desc}
              onChange={(e) => {
                setDesc(e.target.value);
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="button" data-testid="create-project" onClick={submit}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsGrid({
  projects,
  onNew,
  onOpen,
  chatCountByProject = {},
  now,
  dialogOpen,
  onDialogChange,
  onCreate,
}: {
  projects: readonly Project[];
  onNew: () => void;
  onOpen: (id: string) => void;
  chatCountByProject?: Record<string, number>;
  now?: number;
  /** Dialog wiring owned by the App agent; exposed here only. */
  dialogOpen?: boolean;
  onDialogChange?: (open: boolean) => void;
  onCreate?: (input: NewProjectInput) => void;
}): React.JSX.Element {
  const [q, setQ] = useState("");
  const needle = q.toLowerCase();
  const visible = projects.filter((p) =>
    `${p.name} ${projectDescription(p)}`.toLowerCase().includes(needle),
  );
  return (
    <div className="page-frame">
      <div className="page-col">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="font-serif text-2xl text-neutral-100">Projects</h1>
        <Button onClick={onNew}>
          <Plus aria-hidden="true" />
          New project
        </Button>
      </div>
      <Input
        aria-label="Search projects"
        data-testid="project-search"
        placeholder="Search projects"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
        }}
      />
      <div data-testid="projects-grid" className="page-grid">
        {visible.map((p) => {
          const updated = formatProjectUpdated(p.updatedAt, now);
          const meta =
            updated === null
              ? formatChatCount(chatCountByProject[p.id] ?? 0)
              : `${formatChatCount(chatCountByProject[p.id] ?? 0)} · ${updated}`;
          return (
            <Card
              key={p.id}
              data-testid={`project-card-${p.id}`}
              className="project-card shadow-none transition-colors hover:bg-accent/50"
            >
              <CardHeader className="project-card-head">
                <CardTitle>
                  <button
                    type="button"
                    className="flex items-center gap-2 hover:underline"
                    onClick={() => {
                      onOpen(p.id);
                    }}
                  >
                    <span
                      aria-hidden="true"
                      data-testid={`project-dot-${p.id}`}
                      className="inline-block size-2.5 rounded-full"
                      style={{ background: projectDotColor(p) }}
                    />
                    {p.name}
                  </button>
                </CardTitle>
                {projectDescription(p) !== "" && (
                  <CardDescription>{projectDescription(p)}</CardDescription>
                )}
                <p
                  data-testid={`project-meta-${p.id}`}
                  className="mt-auto text-xs text-neutral-400"
                >
                  {meta}
                </p>
              </CardHeader>
            </Card>
          );
        })}
      </div>
      {visible.length === 0 && (
        <div className="empty-frame">
          <p data-testid="projects-empty" className="text-sm text-neutral-400">
            No projects found.
          </p>
        </div>
      )}
      <NewProjectDialog
        open={dialogOpen ?? false}
        onOpenChange={onDialogChange ?? (() => {})}
        onCreate={onCreate ?? (() => {})}
      />
      </div>
    </div>
  );
}
