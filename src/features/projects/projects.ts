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
