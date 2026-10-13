import { transcriptRead } from "../turn/turn";
import {
  containsKeyMaterial,
  threadToHtml,
  threadToMarkdown,
  type ExportBlock,
} from "./retention";
import type { RenderRow } from "../transcript/types";

/** One downloaded file's name: sanitised title, thread-id fallback. Windows
 *  reserved characters are stripped (never a path separator in a download),
 *  length capped so runaway auto-titles stay usable. */
export function exportFilename(title: string, id: string, format: "md" | "html"): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 80);
  return `${safe === "" ? `thread-${id}` : safe}.${format}`;
}

/**
 * Flatten one contract row to exportable text. Thinking never survives —
 * `stripThinkingForExport` enforces that downstream too; this mapper only
 * chooses the readable field per kind. (Moved out of SettingsDialog so the
 * rail's Export and Settings → Data share one pipeline — review 31.)
 */
export function rowToExportBlock(row: RenderRow): ExportBlock {
  const block = row.block;
  switch (block.kind) {
    case "text":
      return { kind: "text", text: block.text };
    case "thinking":
      return { kind: "thinking", text: block.text };
    case "tool_use":
      return { kind: "tool_use", text: `${block.name} ${block.input_json}` };
    case "tool_result":
      return { kind: "tool_result", text: block.preview };
    case "artifact_ref":
      return { kind: "artifact_ref", text: block.title };
    case "question_card":
      return { kind: "question_card", text: block.prompt };
    case "summary":
      return { kind: "summary", text: block.text };
    case "compaction":
      return { kind: "compaction", text: block.provider_block_id };
    case "notice":
      return { kind: "notice", text: block.text };
  }
}

export interface ExportOutcome {
  /** Download written? */
  ok: boolean;
  /** Sanitised file name, or null when nothing was written. */
  filename: string | null;
  /** Block count for the caller's success line, or null on failure. */
  blocks: number | null;
  /** Typed failure for the caller's notice — blocked, read error, DOM error. */
  error: string | null;
}

/**
 * Read → guard → download (review 31: Settings and the rail used to carry
 * two copies of this pipeline, drifting filename + guard behaviour). The
 * key-material scan blocks the write, never warns past it: an export
 * carrying a secret is worse than no export. Never throws across the UI
 * boundary — every failure is a typed outcome the caller renders.
 */
export async function exportThreadDownload(
  threadId: string,
  title: string,
  format: "md" | "html",
): Promise<ExportOutcome> {
  try {
    const rows = await transcriptRead(threadId);
    const blocks: ExportBlock[] = rows.map(rowToExportBlock);
    const joined = blocks.map((b) => b.text ?? b.kind).join("\n");
    if (containsKeyMaterial(joined)) {
      return {
        ok: false,
        filename: null,
        blocks: null,
        error: "Export blocked: the transcript looks like it contains key material.",
      };
    }
    const filename = exportFilename(title, threadId, format);
    const body = format === "md" ? threadToMarkdown(title, blocks) : threadToHtml(title, blocks);
    const blob = new Blob([body], {
      type: format === "md" ? "text/markdown" : "text/html",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: true, filename, blocks: blocks.length, error: null };
  } catch (e) {
    return {
      ok: false,
      filename: null,
      blocks: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
