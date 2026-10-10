export interface ProjectMemory {
  projectId: string | null;
  topic: string;
}

export interface ProjectFile {
  name: string;
  sizeBytes: number;
}

export interface ProjectChatSummary {
  id: string;
  title: string;
}

export interface Project {
  id: string;
  name: string;
  /** Short blurb shown on the grid card (HTML mock `p.desc`). */
  desc?: string;
  /** Alias accepted wherever a description is read. */
  description?: string;
  /** Stable dot color. Assigned by the caller; absent means hash fallback. */
  color?: string;
  /** ISO date string driving the "Updated …" line. Absent means no claim. */
  updatedAt?: string;
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

/** Dot palette for project cards. Index is never positional — see projectColor. */
export const PROJECT_COLORS: readonly string[] = [
  "#e11d48",
  "#f97316",
  "#f59e0b",
  "#10b981",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

/**
 * Deterministic color fallback for a project id (djb2 hash into the palette).
 * Never index-based: reordering the project list cannot change a dot.
 */
export function projectColor(id: string): string {
  let hash = 5381;
  for (let i = 0; i < id.length; i += 1) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % PROJECT_COLORS.length;
  return PROJECT_COLORS[index];
}

/** Explicit `color` wins; otherwise the deterministic hash fallback. */
export function projectDotColor(p: Project): string {
  return p.color ?? projectColor(p.id);
}

/** `desc` or `description`, whichever the caller supplied. */
export function projectDescription(p: Project): string {
  return p.desc ?? p.description ?? "";
}

/**
 * Relative "Updated …" line. Returns null when the project carries no (valid)
 * timestamp so callers make no claim instead of fabricating one.
 */
export function formatProjectUpdated(
  updatedAt: string | undefined,
  now: number = Date.now(),
): string | null {
  if (updatedAt === undefined || updatedAt === "") return null;
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) return null;
  const days = Math.round((now - parsed) / 86_400_000);
  if (days <= 0) return "Updated today";
  return `Updated ${String(days)} day${days === 1 ? "" : "s"} ago`;
}

export function formatChatCount(count: number): string {
  return `${String(count)} chat${count === 1 ? "" : "s"}`;
}

export function formatFileSize(bytes: number): string {
  const clamped = Math.max(0, Math.floor(bytes));
  if (clamped < 1024) return `${String(clamped)} B`;
  const kb = clamped / 1024;
  if (kb < 1024) return `${kb >= 100 ? String(Math.round(kb)) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb >= 100 ? String(Math.round(gb)) : gb.toFixed(1)} GB`;
}

/** Sample capacity used only when the caller supplies no real one (labeled). */
export const PROJECT_KNOWLEDGE_SAMPLE_CAPACITY_BYTES = 50 * 1024 * 1024;

export interface KnowledgeUsage {
  usedBytes: number;
  percent: number;
  label: string;
}

/**
 * Honest capacity from real file sizes. The percent is always derived from
 * the bytes at hand — never a hardcoded constant.
 */
export function knowledgeUsage(
  files: readonly ProjectFile[],
  capacityBytes: number = PROJECT_KNOWLEDGE_SAMPLE_CAPACITY_BYTES,
): KnowledgeUsage {
  const usedBytes = files.reduce((sum, f) => sum + Math.max(0, f.sizeBytes), 0);
  const percent =
    capacityBytes > 0 ? Math.min(100, Math.round((usedBytes / capacityBytes) * 100)) : 0;
  return { usedBytes, percent, label: `${String(percent)}% of project knowledge used` };
}
