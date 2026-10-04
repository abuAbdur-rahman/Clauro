/**
 * Model catalogue types + limit resolution (Task 003, CONTRACTS.md §5).
 *
 * Shapes mirror the contract: `ModelRef`, `ModelLimits`, `LimitSources`,
 * `UnknownModel`. Resolution order is conversation → adapter spec → server
 * snapshot, first present value wins per field. Absent everywhere means
 * unknown — never zero.
 */
import { z } from "zod";

export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const ModelLimitsSchema = z.object({
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  reasoning: z.boolean(),
  toolCall: z.boolean(),
});
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;

const LimitSourceSchema = ModelLimitsSchema.partial();
export type LimitSource = z.infer<typeof LimitSourceSchema>;

export const LimitSourcesSchema = z.object({
  conversation: LimitSourceSchema.optional(),
  adapterSpec: LimitSourceSchema.optional(),
  serverSnapshot: LimitSourceSchema.optional(),
});
export type LimitSources = z.infer<typeof LimitSourcesSchema>;

export interface UnknownModel {
  kind: "unknown-model";
  ref: ModelRef;
}

export type ResolvedLimits = { limits: ModelLimits } | { unknown: UnknownModel };

const UNKNOWN_REF: ModelRef = { provider: "anthropic", id: "mystery" };

function first<T>(...vals: (T | undefined)[]): T | undefined {
  for (const v of vals) {
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Resolve limits through the chain. Every field unknown → the whole model is
 * unknown. Partial knowledge resolves per field; nothing is zero-guessed.
 */
export function resolveLimits(sources: LimitSources): ResolvedLimits {
  const parsed = LimitSourcesSchema.parse(sources);
  const contextWindow = first(
    parsed.conversation?.contextWindow,
    parsed.adapterSpec?.contextWindow,
    parsed.serverSnapshot?.contextWindow,
  );
  const maxOutput = first(
    parsed.conversation?.maxOutput,
    parsed.adapterSpec?.maxOutput,
    parsed.serverSnapshot?.maxOutput,
  );
  const reasoning = first(
    parsed.conversation?.reasoning,
    parsed.adapterSpec?.reasoning,
    parsed.serverSnapshot?.reasoning,
  );
  const toolCall = first(
    parsed.conversation?.toolCall,
    parsed.adapterSpec?.toolCall,
    parsed.serverSnapshot?.toolCall,
  );
  if (
    contextWindow === undefined ||
    maxOutput === undefined ||
    reasoning === undefined ||
    toolCall === undefined
  ) {
    return { unknown: { kind: "unknown-model", ref: { ...UNKNOWN_REF } } };
  }
  return { limits: { contextWindow, maxOutput, reasoning, toolCall } };
}

export interface ModelWithLimits extends ModelRef, ModelLimits {
  name: string;
}

/**
 * Warnings for a per-thread model switch. The thread stays open and
 * `tools_frozen` is untouched (D19) — a switch warns, never blocks.
 *
 * Thinking blocks are account-bound: moving between reasoning models drops
 * prior thinking. Switching on Sonnet-class models surfaces exactly that.
 */
export function switchWarnings(from: ModelWithLimits, to: ModelWithLimits): string[] {
  if (from.provider === to.provider && from.id === to.id) return [];
  if (from.reasoning || to.reasoning) {
    return [
      `Switching from ${from.id} to ${to.id}: prior thinking blocks are ` +
        `account-bound and will be dropped. The thread stays open; completed work is kept.`,
    ];
  }
  return [];
}

/**
 * Stable hash of system-prompt text. Effort (`D76`) travels as request
 * parameters only and must never enter this hash — the test in
 * `models.test.ts` locks that property. djb2-xor: dependency-free and
 * deterministic; this is an identity check, not cryptography.
 */
export function hashSystemPrompt(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
    h >>>= 0;
  }
  return h.toString(16).padStart(8, "0");
}
