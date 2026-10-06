export interface ProjectMemory {
  projectId: string | null;
  topic: string;
}

export interface Project {
  id: string;
  name: string;
}

/** Per-project isolation both directions (D35). Global (null) never leaks. */
export function memoryVisibleTo(
  rows: readonly ProjectMemory[],
  projectId: string | null,
): ProjectMemory[] {
  return rows.filter((r) => r.projectId === projectId);
}

/** Opaque ID authoritative; rename moves no files (D32). */
export function renameProject(p: Project, name: string): Project {
  return { ...p, name };
}

/** Dedupe scope is the project, never global (D52). */
export function attachmentKey(projectId: string | null, hash: string): string {
  return `${projectId ?? "global"}:${hash}`;
}

export type MemoryControl = "account-pause" | "account-reset" | "thread-off" | "sensitive";

/** Four controls are four distinct behaviours, never collapsed (D8). */
export function describeControl(c: MemoryControl): string {
  switch (c) {
    case "account-pause":
      return "pause keeps memory, stops using + writing, no backfill on resume";
    case "account-reset":
      return "reset permanent, irreversible, includes project memories";
    case "thread-off":
      return "per-thread off set before first send, locks after";
    case "sensitive":
      return "sensitive topics off by default, review notice on every save";
  }
}

/** Instructions block reaches system prompt as part of frozen system (D35). */
export function frozenSystem(instructions: string, base: string): string {
  return instructions ? `${base}\n\nProject instructions:\n${instructions}` : base;
}
