/**
 * Turn bridge (023 host obligation). Thin invoke wrappers around the Rust
 * commands, plus the event-channel parsing the view listens on.
 *
 * Every payload is Zod-validated at the boundary — the same rule as
 * `features/catalogue/catalogue.ts`. Unknown shapes throw a typed error; the
 * view shows a notice, never a crash.
 *
 * Channels (mirroring `src-tauri/src/turn.rs`):
 * - `clauro://turn-event` — one payload per mapped provider event, as it
 *   arrives. The view accumulates text deltas into the streaming row.
 * - `clauro://turn-done` — once, when the turn ends for any reason. The view
 *   re-reads the transcript: the store is the record, the events were hints.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { Transcript } from "../transcript/types";
import type { RenderRow } from "../transcript/types";

export const TURN_EVENT = "clauro://turn-event";
export const TURN_DONE = "clauro://turn-done";

const TurnEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("block_start"),
    index: z.number().int().nonnegative(),
    kind: z.string().min(1),
    tool_id: z.string().nullable().optional(),
    tool_name: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("text_delta"), index: z.number().int().nonnegative(), text: z.string() }),
  z.object({
    type: z.literal("thinking_delta"),
    index: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({ type: z.literal("block_stop"), index: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("usage"),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("notice"), text: z.string() }),
]);
export type TurnEvent = z.infer<typeof TurnEventSchema>;

const TurnEventEnvelopeSchema = z.object({
  thread_id: z.string().min(1),
  event: TurnEventSchema,
});
export type TurnEventEnvelope = z.infer<typeof TurnEventEnvelopeSchema>;

/** Validate one streaming payload. Throws on garbage. */
export function parseTurnEvent(raw: unknown): TurnEventEnvelope {
  return TurnEventEnvelopeSchema.parse(raw);
}

const TurnDoneSchema = z.union([
  z.object({
    thread_id: z.string().min(1),
    end: z.string().min(1),
    dispatched: z.array(z.string()),
    assistant_messages: z.number().int().nonnegative(),
    pending_approvals: z.array(z.string()),
  }),
  z.object({ thread_id: z.string().min(1), error: z.string() }),
]);
export type TurnDone = z.infer<typeof TurnDoneSchema>;

/** Validate the terminal payload. Throws on garbage. */
export function parseTurnDone(raw: unknown): TurnDone {
  return TurnDoneSchema.parse(raw);
}

/** Validate transcript rows from the host. Throws on garbage. */
export function parseTranscript(raw: unknown): RenderRow[] {
  return Transcript.parse(raw);
}

export interface TurnStartParams {
  threadId: string;
  text: string;
  provider: string;
  model: string;
  effort: string;
  maxTokens: number;
}

/** Start a turn. Returns at once; the turn reports through the channels. */
export async function turnStart(params: TurnStartParams): Promise<{ thread_id: string }> {
  // Wire keys are camelCase to match what Tauri passes to the Rust command:
  // Tauri exposes Rust `thread_id`/`max_tokens` params as `threadId`/
  // `maxTokens` on the JS side, and invoke matches those names exactly.
  // REGRESSION (proven by the running app 2026-10-07): snake_case keys fail
  // at runtime with "missing required key threadId" while the transcript
  // shows an orange error dump instead of rows. The test below pins every
  // key of every turn command.
  const raw: unknown = await invoke("turn_start", {
    threadId: params.threadId,
    text: params.text,
    provider: params.provider,
    model: params.model,
    effort: params.effort,
    maxTokens: params.maxTokens,
  });
  return z.object({ thread_id: z.string() }).parse(raw);
}

/** Stop a running turn. Resolves true when a turn was actually running. */
export async function turnStop(threadId: string): Promise<boolean> {
  const raw: unknown = await invoke("turn_stop", { threadId });
  return z.boolean().parse(raw);
}

/** Re-read one thread's transcript. The repair path for a missed event. */
export async function transcriptRead(threadId: string): Promise<RenderRow[]> {
  const raw: unknown = await invoke("transcript_read", { threadId });
  return parseTranscript(raw);
}

const ArtifactLatestSchema = z.object({
  artifactId: z.string().min(1),
  version: z.number().int().nonnegative(),
  title: z.string(),
  mediaType: z.string().min(1),
  source: z.string(),
});
export type ArtifactLatest = z.infer<typeof ArtifactLatestSchema>;

/**
 * The thread's newest artifact (row metadata + source bytes), or `null` when
 * the thread has none. The drawer's producer calls this on turn-done and on
 * mount (D121); the shape is validated, never trusted.
 */
export async function artifactLatest(threadId: string): Promise<ArtifactLatest | null> {
  const raw: unknown = await invoke("artifact_latest", { threadId });
  return raw === null ? null : ArtifactLatestSchema.parse(raw);
}

const AnswerResolutionSchema = z.object({
  card_id: z.string().min(1),
  resolved: z.string(),
});
export type AnswerResolution = z.infer<typeof AnswerResolutionSchema>;

export interface QuestionAnswerParams {
  threadId: string;
  toolCallId: string;
  answer: string;
  provider: string;
  model: string;
  effort: string;
  maxTokens: number;
}

/**
 * Answer an awaiting question card. The host validates, persists the answer
 * as the call's one result, and resumes the turn — so this resolves when the
 * answer is accepted, while the resumed turn reports through the channels.
 * Rejects typed on unknown/already-answered/invalid answers.
 */
export async function questionAnswer(params: QuestionAnswerParams): Promise<AnswerResolution> {
  const raw: unknown = await invoke("question_answer", {
    threadId: params.threadId,
    toolCallId: params.toolCallId,
    answer: params.answer,
    provider: params.provider,
    model: params.model,
    effort: params.effort,
    maxTokens: params.maxTokens,
  });
  return AnswerResolutionSchema.parse(raw);
}

/** Subscribe to streaming events for one thread. Returns the unlistener. */
export async function listenTurnEvents(
  threadId: string,
  onEvent: (event: TurnEvent) => void,
): Promise<() => void> {
  return listen<unknown>(TURN_EVENT, (envelope) => {
    const parsed = TurnEventEnvelopeSchema.safeParse(envelope.payload);
    // Another thread's events are not ours; an unparseable payload is a
    // notice-shaped problem, never a crash — ignore it here, the done-path
    // re-read repairs whatever was missed.
    if (!parsed.success || parsed.data.thread_id !== threadId) return;
    onEvent(parsed.data.event);
  });
}

/** Subscribe to the terminal event for one thread. Returns the unlistener. */
export async function listenTurnDone(
  threadId: string,
  onDone: (done: TurnDone) => void,
): Promise<() => void> {
  return listen<unknown>(TURN_DONE, (envelope) => {
    const parsed = TurnDoneSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    if (!("thread_id" in parsed.data) || parsed.data.thread_id !== threadId) return;
    onDone(parsed.data);
  });
}