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

// ── add/edit dialog contract ─────────────────────────────────────────────
// The dialog validates client-side (B23) before any invoke runs: name
// required, http(s) URL always required, key required except ollama. The
// stored key is never echoed back — the dialog only ever collects a
// replacement.

export const PROVIDER_TYPES = ["openrouter", "agentrouter", "ollama", "google", "custom"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PROVIDER_PRESETS: Record<
  ProviderType,
  { label: string; name: string; baseUrl: string }
> = {
  openrouter: { label: "OpenRouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  agentrouter: { label: "AgentRouter", name: "AgentRouter", baseUrl: "https://agentrouter.org/v1" },
  ollama: { label: "Ollama (local)", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1" },
  google: { label: "Google", name: "Google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  custom: { label: "Custom (OpenAI-compatible)", name: "", baseUrl: "" },
};

const HTTP_URL = /^https?:\/\/.+/i;

export const ProviderFormSchema = z
  .object({
    type: z.enum(PROVIDER_TYPES),
    name: z.string().trim().min(1, "Name is required"),
    baseUrl: z.string().trim(),
    key: z.string(),
  })
  .superRefine((val, ctx) => {
    const url = val.baseUrl.trim();
    if (!HTTP_URL.test(url)) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Base URL must be an http(s) URL",
      });
    }
    if (val.type !== "ollama" && val.key.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["key"], message: "Key is required" });
    }
  });
export type ProviderForm = z.infer<typeof ProviderFormSchema>;

/**
 * Whether the dialog's Save may enable. Edit mode passes
 * `{ allowBlankKey: true }`: a blank key means "keep the stored one" and
 * waives only the key rule — a bad URL or blank name still fails.
 */
export function isProviderFormValid(raw: unknown, opts?: { allowBlankKey?: boolean }): boolean {
  if (ProviderFormSchema.safeParse(raw).success) return true;
  if (opts?.allowBlankKey === true && typeof raw === "object" && raw !== null) {
    const rec = raw as Record<string, unknown>;
    if (typeof rec["key"] === "string" && rec["key"].trim() === "") {
      return ProviderFormSchema.safeParse({ ...rec, key: "keep-existing-key" }).success;
    }
  }
  return false;
}

/**
 * Custom and ollama adds need a row id the dialog never asks for — derive
 * it from the display name so Save has something honest to send.
 */
export function slugifyProviderId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "custom" : slug;
}
