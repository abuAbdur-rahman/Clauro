/**
 * Catalogue bridge (Task 003). Thin invoke wrappers around the Rust commands;
 * every payload is Zod-validated at the boundary. Unknown shapes throw a typed
 * error — the picker shows a notice, never a crash.
 */
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export const CatalogueModelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  context_window: z.number().int().positive(),
  max_output: z.number().int().positive(),
  reasoning: z.boolean(),
  tool_call: z.boolean(),
});
export type CatalogueModel = z.infer<typeof CatalogueModelSchema>;

const CatalogueSchema = z.object({
  providers: z.record(z.string(), z.array(CatalogueModelSchema)),
});

const CataloguePayloadSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("live"),
    models: z.number().int().nonnegative(),
    catalogue: CatalogueSchema,
  }),
  z.object({
    state: z.literal("cached"),
    models: z.number().int().nonnegative(),
    catalogue: CatalogueSchema,
    notice: z.string().optional(),
  }),
  z.object({ state: z.literal("absent") }),
  z.object({ state: z.literal("stale"), models: z.number().int().nonnegative() }),
]);
export type CataloguePayload = z.infer<typeof CataloguePayloadSchema>;

/** Validate a catalogue payload from the host. Throws on garbage. */
export function parseCataloguePayload(raw: unknown): CataloguePayload {
  return CataloguePayloadSchema.parse(raw);
}

/** One-line rendering of a boundary error. Zod dumps are for logs, not UI. */
export function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
}

/** Refresh: live fetch, cached fallback, honest empty. Never throws raw. */
export async function refreshCatalogue(): Promise<CataloguePayload> {
  const raw: unknown = await invoke("catalogue_refresh");
  return parseCataloguePayload(raw);
}

const WebviewStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("present"), version: z.string() }),
  z.object({ kind: z.literal("missing"), hint: z.string() }),
]);
export type WebviewStatus = z.infer<typeof WebviewStatusSchema>;

export async function webviewStatus(): Promise<WebviewStatus> {
  const raw: unknown = await invoke("webview_status");
  return WebviewStatusSchema.parse(raw);
}

const KeyringErrorSchema = z.object({
  kind: z.enum(["unavailable", "failed"]),
  reason: z.string().optional(),
});

export async function keyringStore(account: string, secret: string): Promise<void> {
  await invoke("keyring_store", { account, secret });
}

export async function keyringRetrieve(account: string): Promise<string> {
  const raw: unknown = await invoke("keyring_retrieve", { account });
  return z.string().parse(raw);
}

export async function keyringAvailable(): Promise<boolean> {
  try {
    await invoke("keyring_available");
    return true;
  } catch (e: unknown) {
    const parsed = KeyringErrorSchema.safeParse(e);
    // Unavailable backend is a fact, not a crash. Anything else rethrows.
    if (parsed.success && parsed.data.kind === "unavailable") return false;
    throw e;
  }
}
