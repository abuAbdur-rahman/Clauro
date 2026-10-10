/**
 * Browser harness mocks (UI-GUIDE, AGENT-PROMPT Step 1; Task 029 mock mode).
 * When Vite runs with `--mode browser` (`pnpm dev:web`) or `--mode mock`
 * (`pnpm dev:mock`), the Tauri API modules resolve to this file instead of
 * `@tauri-apps/api/*`, so the exact same `<App />` renders without a Tauri
 * runtime. Production builds and `tauri dev` never see it: the alias lives
 * only in the browser/mock branch of `vite.config.ts`.
 *
 * Seed policy (Task 029 slice 2): seed is ALWAYS on in mock mode —
 * deterministic for agents. The old `?providers` param is REPLACED (removed):
 * `provider_list`, `provider_models_enriched`, `provider_models`,
 * `transcript_read` serve `@/mock/seed.ts` verbatim. `?seed=0` resolves empty
 * for every seed command (bare shell for empty-state testing);
 * `?seed=anything-else-or-absent` serves the full seed.
 *
 * Determinism: no `Date.now()` in seed paths — `models_fetched_at` is
 * `SEED_NOW/1000` (fixed). Unknown thread ids resolve honest empty, never
 * fake rows (blockers B18 rule). Every unknown command throws — a missing
 * mock must fail loudly, never render as fake data.
 */
import { SEED_CHATS, SEED_MODEL_META, SEED_NOW, SEED_PROVIDERS } from "@/mock/seed";

const SEED_FETCHED_AT: number = Math.floor(SEED_NOW / 1000);

function seedDisabled(): boolean {
  return new URLSearchParams(window.location.search).get("seed") === "0";
}

function threadIdOf(args: Record<string, unknown> | undefined, fallback: string): string {
  const raw = args?.["threadId"] ?? args?.["thread_id"];
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

function toEnriched(modelId: string): {
  id: string;
  display_name: string;
  limits_known: boolean;
  context_window: number | null;
  max_output: number | null;
  reasoning: boolean;
  tool_call: boolean;
} {
  const meta: { ctx: number; tags: string[] } | undefined = (
    SEED_MODEL_META as Record<string, { ctx: number; tags: string[] } | undefined>
  )[modelId];
  if (meta === undefined) {
    return {
      id: modelId,
      display_name: modelId,
      limits_known: false,
      context_window: null,
      max_output: null,
      reasoning: false,
      tool_call: false,
    };
  }
  return {
    id: modelId,
    display_name: modelId,
    limits_known: true,
    context_window: meta.ctx,
    max_output: null,
    reasoning: meta.tags.includes("reasoning"),
    tool_call: true,
  };
}

function enrichedFor(providerId: string | undefined): Array<ReturnType<typeof toEnriched>> {
  if (typeof providerId === "string" && providerId.length > 0) {
    const found = SEED_PROVIDERS.find((p) => p.id === providerId);
    if (found === undefined) return [];
    if (!found.enabled) return [];
    return found.models.map(toEnriched);
  }
  return SEED_PROVIDERS.filter((p) => p.enabled).flatMap((p) => p.models.map(toEnriched));
}

export function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const bare = seedDisabled();
  switch (cmd) {
    case "webview_status":
      return Promise.resolve({ kind: "present", version: "browser-harness" });
    case "provider_list":
      if (bare) return Promise.resolve([]);
      return Promise.resolve(
        SEED_PROVIDERS.map((p) => ({
          id: p.id,
          display_name: p.name,
          kind: p.type,
          base_url: p.baseUrl,
          model_count: p.models.length,
          models_fetched_at: SEED_FETCHED_AT,
          stale: false,
          has_key: p.key.length > 0,
        })),
      );
    case "provider_models_enriched": {
      if (bare) return Promise.resolve([]);
      const rawId: unknown = args?.["id"];
      const id = typeof rawId === "string" ? rawId : undefined;
      return Promise.resolve(enrichedFor(id));
    }
    case "provider_models": {
      const rawId: unknown = args?.["id"];
      const id = typeof rawId === "string" ? rawId : "";
      if (bare) {
        return Promise.resolve({
          provider_id: id,
          models: [],
          models_fetched_at: null,
          stale: true,
        });
      }
      const found = SEED_PROVIDERS.find((p) => p.id === id);
      if (found === undefined || !found.enabled) {
        return Promise.resolve({
          provider_id: id,
          models: [],
          models_fetched_at: null,
          stale: true,
        });
      }
      return Promise.resolve({
        provider_id: id,
        models: found.models.map((m) => ({ id: m, display_name: m })),
        models_fetched_at: SEED_FETCHED_AT,
        stale: false,
      });
    }
    case "transcript_read": {
      if (bare) return Promise.resolve([]);
      const tid = threadIdOf(args, "");
      if (tid === "") return Promise.resolve([]);
      const chat = SEED_CHATS.find((c) => c.id === tid);
      if (chat === undefined) return Promise.resolve([]);
      return Promise.resolve(
        chat.messages.map((m, i) => ({
          block: { kind: "text", text: m.text },
          role: m.role,
          id: `${chat.id}-${String(i)}`,
          seq: i,
          generation: 0,
        })),
      );
    }
    case "turn_start":
      // Bare shell still needs a thread id to open a chat; echo request.
      return Promise.resolve({ thread_id: threadIdOf(args, "c1") });
    case "turn_stop":
      return Promise.resolve(true);
    case "artifact_csp":
      return Promise.resolve("default-src 'none'; script-src 'nonce-browser-harness'");
    // D123: there is no Rust registry in the browser harness, so the document
    // travels in the URL itself — a `data:` URL the frame can navigate to.
    // Empty input is refused rather than published, matching Rust's refusal:
    // a blank frame must never be the answer.
    case "artifact_publish": {
      const nonce = typeof args?.nonce === "string" ? args.nonce : "";
      const doc = typeof args?.doc === "string" ? args.doc : "";
      if (nonce.trim() === "") {
        return Promise.reject(
          new Error('browser harness invoke("artifact_publish") refused: missing nonce'),
        );
      }
      if (doc.trim() === "") {
        return Promise.reject(
          new Error('browser harness invoke("artifact_publish") refused: empty artifact document'),
        );
      }
      return Promise.resolve(
        `data:text/html;charset=utf-8,${encodeURIComponent(doc)}`,
      );
    }
    case "keyring_available":
      return Promise.resolve(undefined);
    default:
      return Promise.reject(
        new Error(
          `browser harness has no mock for invoke("${cmd}") ` +
            `with args [${Object.keys(args ?? {}).join(", ")}]`,
        ),
      );
  }
}

/** Last handler per event, so a future harness can replay turns. */
const eventHandlers = new Map<string, (envelope: { payload: unknown }) => void>();

export function listen(
  event: string,
  handler: (envelope: { payload: unknown }) => void,
): Promise<() => void> {
  // No live events in the harness; the done-path re-read covers everything.
  // The handler is retained (not dropped) so nothing is silently lost if a
  // replay path is added later.
  eventHandlers.set(event, handler);
  return Promise.resolve(() => {
    eventHandlers.delete(event);
  });
}
