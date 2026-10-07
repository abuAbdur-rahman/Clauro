/**
 * Provider bridge. Thin invoke wrappers around the Rust commands, every
 * payload Zod-validated at the boundary — the same rule as the catalogue and
 * turn bridges. Unknown shapes throw a typed error; the view shows a notice.
 *
 * Wire keys are snake_case to match the Rust params exactly (see turn.ts).
 */
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const ProviderViewSchema = z.object({
  id: z.string().min(1),
  display_name: z.string(),
  kind: z.string().min(1),
  base_url: z.string().nullable(),
  model_count: z.number().int().nonnegative(),
  models_fetched_at: z.number().int().nullable(),
  stale: z.boolean(),
  has_key: z.boolean(),
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/** Validate the provider list. Throws on garbage. */
export function parseProviderList(raw: unknown): ProviderView[] {
  return z.array(ProviderViewSchema).parse(raw);
}

const ProviderModelSchema = z.object({
  id: z.string().min(1),
  display_name: z.string(),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

const ModelsViewSchema = z.object({
  provider_id: z.string().min(1),
  models: z.array(ProviderModelSchema),
  models_fetched_at: z.number().int().nullable(),
  stale: z.boolean(),
});
export type ModelsView = z.infer<typeof ModelsViewSchema>;

/** Validate one provider's stored models. Throws on garbage. */
export function parseModelsView(raw: unknown): ModelsView {
  return ModelsViewSchema.parse(raw);
}

const EnrichedModelSchema = z.object({
  id: z.string().min(1),
  display_name: z.string(),
  limits_known: z.boolean(),
  context_window: z.number().int().positive().nullable(),
  max_output: z.number().int().positive().nullable(),
  reasoning: z.boolean(),
  tool_call: z.boolean(),
});
export type EnrichedModel = z.infer<typeof EnrichedModelSchema>;

/** Validate enriched models. Throws on garbage. */
export function parseEnrichedModels(raw: unknown): EnrichedModel[] {
  return z.array(EnrichedModelSchema).parse(raw);
}

/** Every configured provider. Empty is unconfigured, not an error. */
export async function providerList(): Promise<ProviderView[]> {
  const raw: unknown = await invoke("provider_list");
  return parseProviderList(raw);
}

/** Add a built-in provider. No models yet — the key arrives separately. */
export async function providerAddBuiltin(id: string): Promise<ProviderView> {
  const raw: unknown = await invoke("provider_add_builtin", { id });
  return ProviderViewSchema.parse(raw);
}

/** Add a custom OpenAI-compatible endpoint. Validated structurally in Rust. */
export async function providerAddCustom(args: {
  id: string;
  displayName: string;
  baseUrl: string;
}): Promise<ProviderView> {
  // camelCase, like the turn commands: Tauri exposes the Rust params
  // `display_name`/`base_url` as `displayName`/`baseUrl` on the JS side.
  const raw: unknown = await invoke("provider_add_custom", {
    id: args.id,
    displayName: args.displayName,
    baseUrl: args.baseUrl,
  });
  return ProviderViewSchema.parse(raw);
}

/** Remove a provider, its models, and its key. Idempotent. */
export async function providerRemove(id: string): Promise<boolean> {
  const raw: unknown = await invoke("provider_remove", { id });
  return z.boolean().parse(raw);
}

/**
 * Store a key and prove it: the host fetches the live model list with it.
 * Rejects on a bad key — and stores nothing — rather than failing at the
 * first turn.
 */
export async function providerSetKey(id: string, key: string): Promise<ModelsView> {
  const raw: unknown = await invoke("provider_set_key", { id, key });
  return parseModelsView(raw);
}

/** Stored models for one provider, with freshness. No key needed to read. */
export async function providerModels(id: string): Promise<ModelsView> {
  const raw: unknown = await invoke("provider_models", { id });
  return parseModelsView(raw);
}

/** Stored models joined with limits enrichment. One invoke per provider. */
export async function providerModelsEnriched(id: string): Promise<EnrichedModel[]> {
  const raw: unknown = await invoke("provider_models_enriched", { id });
  return parseEnrichedModels(raw);
}

/** Re-fetch one provider's live model list. Needs the stored key. */
export async function providerRefresh(id: string): Promise<ModelsView> {
  const raw: unknown = await invoke("provider_refresh", { id });
  return parseModelsView(raw);
}
