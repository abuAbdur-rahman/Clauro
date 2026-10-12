import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, FileText, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import type { Project, ProjectChatSummary, ProjectFile } from "./projects";
import { formatFileSize, knowledgeUsage } from "./projects";

export function ProjectDetail({
  project,
  instructions,
  memoryCount,
  contextUsed,
  onBack,
  chats = [],
  onOpenChat,
  onRename,
  onSaveInstructions,
  onStartChat,
  files,
  capacityBytes,
  onAddFiles,
  onDeleteFile,
}: {
  project: Project;
  instructions: string;
  memoryCount: number;
  contextUsed: string;
  onBack: () => void;
  chats?: readonly ProjectChatSummary[];
  onOpenChat?: (id: string) => void;
  /** Blur-commit for the editable title. */
  onRename?: (name: string) => void;
  onSaveInstructions?: (instructions: string) => void;
  onStartChat?: (message: string) => void;
  /** Knowledge files. Absent = legacy `contextUsed` display, no file UI. */
  files?: readonly ProjectFile[];
  /** Real capacity. Absent = sample capacity, honestly labeled. */
  capacityBytes?: number;
  onAddFiles?: (files: File[]) => void;
  onDeleteFile?: (index: number) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState(project.name);
  const [draft, setDraft] = useState(instructions);
  const [composer, setComposer] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(project.name);
  }, [project.id, project.name]);
  useEffect(() => {
    setDraft(instructions);
  }, [project.id, instructions]);

  function commitTitle(): void {
    const trimmed = title.trim();
    if (trimmed !== "" && trimmed !== project.name) onRename?.(trimmed);
    else setTitle(project.name);
  }

  const dirty = draft !== instructions;
  const usage = files === undefined ? null : knowledgeUsage(files, capacityBytes);

  return (
    <div className="page-frame">
      <div className="mb-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="project-back"
          aria-label="Back to projects"
          title="Back to projects"
          onClick={onBack}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
      </div>
      <div data-testid="project-detail-cols" className="detail-cols">
        <div className="detail-main">
          <input
            aria-label="Project name"
            data-testid="project-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 font-serif text-2xl text-neutral-100 outline-none hover:border-neutral-700 focus:border-neutral-500"
          />
          <div data-testid="project-composer-box" className="rounded-lg border border-border bg-card p-3">
            <Textarea
              aria-label="New chat in project"
              data-testid="project-composer"
              rows={2}
              placeholder="Start a new chat in this project…"
              value={composer}
              onChange={(e) => {
                setComposer(e.target.value);
              }}
            />
            <div className="mt-2 flex items-center justify-end">
              <Button
                type="button"
                size="icon"
                data-testid="project-composer-send"
                aria-label="Start chat"
                title="Start chat"
                disabled={composer.trim() === ""}
                onClick={() => {
                  const text = composer.trim();
                  if (text === "") return;
                  onStartChat?.(text);
                  setComposer("");
                }}
                className="size-8 rounded-full"
              >
                <ArrowUp aria-hidden="true" />
              </Button>
            </div>
          </div>
          <h3
            data-testid="project-chats-heading"
            className="section-heading text-sm font-semibold text-neutral-200"
          >
            Chats
          </h3>
          {chats.length === 0 ? (
            <p
              data-testid="project-chats-empty"
              className="empty-frame text-sm text-neutral-400"
            >
              No chats yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {chats.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    data-testid={`project-chat-${c.id}`}
                    className="chat-row block w-full truncate bg-card text-left text-sm text-neutral-300 hover:bg-accent"
                    onClick={() => {
                      onOpenChat?.(c.id);
                    }}
                  >
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <aside className="detail-side" aria-label="project context">
          <Card data-testid="project-panel-instructions" className="side-card shadow-none">
            <CardHeader className="side-card-head">
              <CardTitle>Instructions</CardTitle>
            </CardHeader>
            <CardContent className="side-card-body">
              <Textarea
                aria-label="Instructions"
                data-testid="project-instructions"
                rows={6}
                placeholder="How should the assistant behave in this project?"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                }}
              />
              <Button
                type="button"
                size="sm"
                data-testid="project-instructions-save"
                disabled={!dirty}
                onClick={() => {
                  onSaveInstructions?.(draft);
                }}
              >
                Save
              </Button>
            </CardContent>
          </Card>
          <Card data-testid="project-panel-memory" className="side-card shadow-none">
            <CardHeader className="side-card-head">
              <CardTitle>Memory</CardTitle>
            </CardHeader>
            <CardContent className="side-card-body">
              <p className="text-sm text-neutral-400">
                {memoryCount} {memoryCount === 1 ? "topic" : "topics"} kept for this project.
              </p>
            </CardContent>
          </Card>
          {files !== undefined && (
            <Card data-testid="project-panel-knowledge" className="side-card shadow-none">
              <CardHeader className="side-card-head">
                <CardTitle>Knowledge</CardTitle>
              </CardHeader>
              <CardContent className="side-card-body">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-neutral-400">
                    {files.length === 0
                      ? "No files yet."
                      : `${String(files.length)} file${files.length === 1 ? "" : "s"}`}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="project-add-files"
                    onClick={() => {
                      fileInput.current?.click();
                    }}
                  >
                    Add files
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    data-testid="project-file-input"
                    aria-label="Add knowledge files"
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      if (picked.length > 0) onAddFiles?.(picked);
                    }}
                  />
                </div>
                {files.map((f, i) => (
                  <div key={`${f.name}-${String(i)}`} className="flex items-center gap-2 text-sm">
                    <FileText aria-hidden="true" className="size-4 flex-none text-neutral-400" />
                    <span data-testid={`project-file-${String(i)}`} className="min-w-0 flex-1 truncate">
                      {f.name}
                    </span>
                    <span className="text-xs text-neutral-400">{formatFileSize(f.sizeBytes)}</span>
                    <button
                      type="button"
                      aria-label={`Delete ${f.name}`}
                      data-testid={`project-file-delete-${String(i)}`}
                      className="grid size-6 flex-none place-items-center rounded text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                      onClick={() => {
                        onDeleteFile?.(i);
                      }}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </button>
                  </div>
                ))}
                {usage !== null && (
                  <div>
                    <p data-testid="project-capacity-label" className="text-xs text-neutral-400">
                      {usage.label}
                      {capacityBytes === undefined ? " (sample capacity)" : ""}
                    </p>
                    <Progress data-testid="project-capacity-bar" value={usage.percent} />
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          <Card data-testid="project-panel-context" className="side-card shadow-none">
            <CardHeader className="side-card-head">
              <CardTitle>Context</CardTitle>
            </CardHeader>
            <CardContent className="side-card-body">
              <p className="text-sm text-neutral-400">
                <span className="text-neutral-100">{usage !== null ? `${String(usage.percent)}%` : contextUsed}</span>{" "}
                of project capacity used
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
