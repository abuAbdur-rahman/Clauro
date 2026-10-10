/**
 * The view-side transcript contract (`CONTRACTS.md` §2, mirrored from
 * `crates/clauro-loop/src/seam.rs`).
 *
 * One shape for both providers (D54): the transcript cannot branch on
 * provider, so a `thinking` block from an Anthropic thinking block and one
 * from OpenAI reasoning tokens are the same variant here.
 *
 * These are parsed from the Tauri command's JSON with `zod` at the boundary —
 * untrusted input becomes a validated type, never an assumed one.
 */
import { z } from "zod";

export const BlockKind = z.enum([
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "artifact_ref",
  "question_card",
  "summary",
  "compaction",
  "notice",
]);
export type BlockKind = z.infer<typeof BlockKind>;

export const ToolStatus = z.enum(["ok", "error", "aborted", "rejected"]);
export type ToolStatus = z.infer<typeof ToolStatus>;

const Text = z.object({ kind: z.literal("text"), text: z.string() });
const Thinking = z.object({
  kind: z.literal("thinking"),
  text: z.string(),
  signature: z.string(),
  display: z.enum(["full", "summary"]),
});
const ToolUse = z.object({
  kind: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input_json: z.string(),
});
const ToolResult = z.object({
  kind: z.literal("tool_result"),
  tool_use_id: z.string(),
  status: ToolStatus,
  preview: z.string(),
  preview_path: z.string().nullable().optional(),
});
const ArtifactRef = z.object({
  kind: z.literal("artifact_ref"),
  artifact_id: z.string(),
  version: z.number(),
  title: z.string(),
});
const QuestionCard = z.object({
  kind: z.literal("question_card"),
  id: z.string(),
  prompt: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  allow_free_text: z.boolean(),
  resolved: z.string().nullable().optional(),
});
const Summary = z.object({
  kind: z.literal("summary"),
  text: z.string(),
  boundary: z.number(),
  generation: z.number(),
});
const Compaction = z.object({ kind: z.literal("compaction"), provider_block_id: z.string() });
const Notice = z.object({
  kind: z.literal("notice"),
  level: z.enum(["info", "warn", "error"]),
  text: z.string(),
});

export const ContentBlock = z.union([
  Text,
  Thinking,
  ToolUse,
  ToolResult,
  ArtifactRef,
  QuestionCard,
  Summary,
  Compaction,
  Notice,
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

/** One rendered row: the block plus the store context a view needs. */
export const RenderRow = z.object({
  block: ContentBlock,
  role: z.string(),
  id: z.string(),
  seq: z.number(),
  generation: z.number(),
});
export type RenderRow = z.infer<typeof RenderRow>;

export const Transcript = z.array(RenderRow);