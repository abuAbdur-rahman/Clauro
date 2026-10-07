export interface ExportBlock {
  kind: string;
  text?: string;
}

/** Strip thinking blocks on export (D-account binding); keep rest. */
export function stripThinkingForExport(blocks: readonly ExportBlock[]): ExportBlock[] {
  return blocks.filter((b) => b.kind !== "thinking");
}

/** Export must contain no key material. */
export function containsKeyMaterial(s: string): boolean {
  return /api[_-]?key\s*=\s*\S+/i.test(s) || /sk-[A-Za-z0-9]{8,}/.test(s);
}

export interface ThreadRow {
  id: string;
  incognito: boolean;
}

/** Incognito never appears in history, search, or memory (D37). */
export function excludeIncognito(rows: readonly ThreadRow[]): ThreadRow[] {
  return rows.filter((r) => !r.incognito);
}

export interface PrefixRow {
  id: string;
  seq: number;
}

/** Fork copies prefix under new ids; source rows untouched (D99). */
export function forkPrefix(
  rows: readonly PrefixRow[],
  newId: (old: string) => string,
): PrefixRow[] {
  return rows.map((r) => ({ ...r, id: newId(r.id) }));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Self-contained HTML per user answer: inline CSS, no external refs. */
export function threadToHtml(title: string, blocks: readonly ExportBlock[]): string {
  const safe = stripThinkingForExport(blocks);
  const body = safe
    .map((b) => `<p>${esc(b.text ?? b.kind)}</p>`)
    .join("\n");
  return `<html><head><meta charset="utf-8"><style>body{font-family:sans-serif}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

/** Markdown export, thinking stripped. */
export function threadToMarkdown(title: string, blocks: readonly ExportBlock[]): string {
  const safe = stripThinkingForExport(blocks);
  return `# ${title}\n\n${safe.map((b) => b.text ?? b.kind).join("\n\n")}\n`;
}

/** Memory export JSON, round-trips. */
export function memoryToJson(mem: unknown): string {
  return JSON.stringify(mem);
}

/** Incognito threads are unexportable + unforkable from UI (D37/D99). */
export function canExportThread(incognito: boolean): boolean {
  return !incognito;
}

export function canForkThread(incognito: boolean): boolean {
  return !incognito;
}
