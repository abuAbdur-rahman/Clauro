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
import {
  SEED_CHATS,
  SEED_MODEL_META,
  SEED_NOW,
  SEED_PROVIDERS,
  pickMockReply,
  type SeedMessage,
} from "@/mock/seed";

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
      // `?seed=0` is the bare shell: always empty, even if an earlier turn in
      // this session recorded live rows — empty-state testing needs stable
      // empties, not session leakage.
      if (bare) return Promise.resolve([]);
      const tid = threadIdOf(args, "");
      if (tid === "") return Promise.resolve([]);
      return Promise.resolve(toTranscriptRows(tid));
    }
    case "turn_start":
      // Mock turn (Task 031 T5): echo the thread id at once, then stream the
      // scripted reply through the retained channel handlers — thinking first
      // (the html's 700ms typing dots), word deltas, then turn-done — so the
      // exact same view code streams without a Rust runtime. `?seed=0` stays
      // silent: a bare shell has nothing scripted to say (honest empty).
      return Promise.resolve(scheduleMockTurn(threadIdOf(args, "c1"), mockUserText(args), bare));
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

/** Every live handler per event: the real channel is a broadcast — ChatView
 * and the artifact producer subscribe to the same channel independently, and
 * a last-writer-wins map would silently drop one of them (proven live:
 * sends vanished with no streaming row and no re-read). */
const eventHandlers = new Map<string, Set<(envelope: { payload: unknown }) => void>>();

/**
 * In-memory thread transcripts (Task 031 T5). Lazily seeded from the seed
 * chats — copies, so a turn never mutates the seed — then extended with every
 * live turn: the user's text at `turn_start`, the scripted reply when it
 * completes. That is what makes mock threads WORK like the html: the
 * turn-done re-read converges on the reply instead of an empty transcript.
 * `?seed=0` stays fully amnesiac: it neither seeds nor records, so the bare
 * shell the empty-state tests need never leaks session rows. Unknown ids stay
 * honest empty until a turn actually happens on them.
 */
const liveThreads = new Map<string, SeedMessage[]>();

function liveMessages(threadId: string): SeedMessage[] {
  const existing = liveThreads.get(threadId);
  if (existing !== undefined) return existing;
  const chat = SEED_CHATS.find((c) => c.id === threadId);
  const rows: SeedMessage[] =
    chat === undefined ? [] : chat.messages.map((m) => ({ role: m.role, text: m.text }));
  liveThreads.set(threadId, rows);
  return rows;
}

function toTranscriptRows(threadId: string): Array<{
  block: { kind: string; text: string };
  role: string;
  id: string;
  seq: number;
  generation: number;
}> {
  if (threadId === "") return [];
  return liveMessages(threadId).map((m, i) => ({
    block: { kind: "text", text: m.text },
    role: m.role,
    id: `${threadId}-${String(i)}`,
    seq: i,
    generation: 0,
  }));
}

/** Emit one payload to every live handler on the channel. */
function emitMockEvent(channel: string, payload: unknown): void {
  for (const handler of eventHandlers.get(channel) ?? []) {
    handler({ payload });
  }
}

function mockUserText(args: Record<string, unknown> | undefined): string {
  const raw = args?.["text"];
  return typeof raw === "string" ? raw : "";
}

/**
 * Round-robin cursor for the non-keyword scripted replies, mirroring the
 * prototype's `S.replyIdx++` (index.html:466). Keyword matches ignore it, so
 * they stay deterministic no matter how many turns ran before.
 */
let mockReplyIndex = 0;

/**
 * Scripted mock turn (Task 031 T5). Fixed small delays keep it deterministic
 * under fake timers; word-split deltas rejoin to the reply text exactly, so
 * the view accumulates the full scripted answer. Returns the `turn_start`
 * acknowledgement. Channel names mirror `features/turn/turn.ts` as literals:
 * importing that module here would cycle through the mocked Tauri alias.
 */
function scheduleMockTurn(
  threadId: string,
  userText: string,
  bare: boolean,
): { thread_id: string } {
  // Bare shell records nothing (amnesiac by design — see transcript_read).
  if (bare) return { thread_id: threadId };
  const rows = liveMessages(threadId);
  if (userText.trim() !== "") rows.push({ role: "user", text: userText });
  {
    const reply = pickMockReply(userText, mockReplyIndex++);
    const words = reply.text.split(" ");
    const wordAt = (i: number): string => (i > 0 ? " " : "") + words[i];
    setTimeout(() => {
      emitMockEvent("clauro://turn-event", {
        thread_id: threadId,
        event: { type: "thinking_delta", index: 0, text: "Thinking…" },
      });
    }, 10);
    words.forEach((_, i) => {
      setTimeout(() => {
        emitMockEvent("clauro://turn-event", {
          thread_id: threadId,
          event: { type: "text_delta", index: 0, text: wordAt(i) },
        });
      }, 20 + i * 5);
    });
    setTimeout(() => {
      // The reply commits BEFORE turn-done emits: the view's done-path
      // re-read must converge on it, never on a transcript that forgot.
      rows.push({ role: "assistant", text: reply.text });
      emitMockEvent("clauro://turn-done", {
        thread_id: threadId,
        end: "EndTurn",
        dispatched: [],
        assistant_messages: 1,
        pending_approvals: [],
      });
    }, 30 + words.length * 5);
  }
  return { thread_id: threadId };
}

export function listen(
  event: string,
  handler: (envelope: { payload: unknown }) => void,
): Promise<() => void> {
  // Broadcast like the real channel: every subscriber gets every payload.
  // A single retained handler would drop whichever of ChatView / the artifact
  // producer subscribed first (Task 031 T5: sends visibly did nothing).
  let handlers = eventHandlers.get(event);
  if (handlers === undefined) {
    handlers = new Set();
    eventHandlers.set(event, handlers);
  }
  handlers.add(handler);
  return Promise.resolve(() => {
    eventHandlers.get(event)?.delete(handler);
  });
}
