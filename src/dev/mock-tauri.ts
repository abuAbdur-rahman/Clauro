/**
 * Browser harness mocks (UI-GUIDE, AGENT-PROMPT Step 1). When Vite runs with
 * `--mode browser` (`pnpm dev:web`), the Tauri API modules resolve to this
 * file instead of `@tauri-apps/api/*`, so the exact same `<App />` renders
 * without a Tauri runtime. Production builds and `tauri dev` never see it:
 * the alias lives only in the browser-mode branch of `vite.config.ts`.
 *
 * Mock data follows UI-GUIDE: no providers by default; `?providers=1` seeds
 * one keyed provider with two models. Every unknown command throws — a
 * missing mock must fail loudly in the console, never render as fake data.
 */
export function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const withProviders = new URLSearchParams(window.location.search).has("providers");
  switch (cmd) {
    case "webview_status":
      return Promise.resolve({ kind: "present", version: "browser-harness" });
    case "provider_list":
      return Promise.resolve(
        withProviders
          ? [
              {
                id: "anthropic",
                display_name: "Anthropic",
                kind: "anthropic",
                base_url: null,
                model_count: 2,
                models_fetched_at: Math.floor(Date.now() / 1000),
                stale: false,
                has_key: true,
              },
            ]
          : [],
      );
    case "provider_models_enriched":
      return Promise.resolve(
        withProviders
          ? [
              {
                id: "claude-haiku-4-5",
                display_name: "Haiku",
                limits_known: true,
                context_window: 200000,
                max_output: 8192,
                reasoning: false,
                tool_call: true,
              },
              {
                id: "mystery-1",
                display_name: "Mystery 1",
                limits_known: false,
                context_window: null,
                max_output: null,
                reasoning: false,
                tool_call: false,
              },
            ]
          : [],
      );
    case "provider_models":
      return Promise.resolve({
        provider_id: "anthropic",
        models: [],
        models_fetched_at: null,
        stale: true,
      });
    case "transcript_read":
      return Promise.resolve([]);
    case "turn_start":
      return Promise.resolve({ thread_id: "thread-001" });
    case "turn_stop":
      return Promise.resolve(true);
    case "artifact_csp":
      return Promise.resolve("default-src 'none'; script-src 'nonce-browser-harness'");
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
