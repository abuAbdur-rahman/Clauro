/**
 * One load of the model picker's entries, shared by every mounted picker
 * (review 32: the home header and the composer footer each ran their own
 * `provider_list` → per-provider `provider_models_enriched` pass at boot, so
 * the same rows were fetched and parsed twice for one screen).
 *
 * The data is global — nothing about it is keyed by thread or view — so the
 * promise is keyed by nothing: first caller starts it, everyone awaits it.
 * A provider mutation calls `invalidateModelEntries` (ProvidersView), and a
 * rejected load clears itself so the next mount retries instead of replaying
 * a stale failure forever.
 */
import { providerList, providerModelsEnriched, type EnrichedModel } from "./providers";

export interface ModelEntry {
  provider: string;
  providerName: string;
  model: EnrichedModel;
  /** Picker value, `provider/model` — never a bare model id. */
  value: string;
}

/** Fetch every configured provider's enriched models, flattens to entries. */
async function fetchModelEntries(): Promise<ModelEntry[]> {
  const providers = await providerList();
  const all: ModelEntry[] = [];
  for (const p of providers) {
    const models = await providerModelsEnriched(p.id);
    for (const model of models) {
      all.push({
        provider: p.id,
        providerName: p.display_name,
        model,
        value: `${p.id}/${model.id}`,
      });
    }
  }
  return all;
}

let inflight: Promise<ModelEntry[]> | null = null;

/**
 * The one in-flight load both picker mounts await, so the bridge is hit once
 * per provider per load — not once per mount (two mounts = 1 + N calls, was
 * 2 × (1 + N)).
 *
 * Rejections clear themselves: caching a failure forever would leave the
 * pickers in their "try again" state for the whole session after one bad
 * moment, and every later mount would replay it instead of retrying.
 */
export function loadModelEntries(): Promise<ModelEntry[]> {
  if (inflight === null) {
    inflight = fetchModelEntries().catch((e: unknown) => {
      inflight = null;
      throw e;
    });
  }
  return inflight;
}

/** Drop the shared load after a provider mutation (add/remove/key/refresh). */
export function invalidateModelEntries(): void {
  inflight = null;
}
