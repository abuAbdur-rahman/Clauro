# Task 005 — SSE transport and the Anthropic adapter

**Phase** 1 · **Depends** `004` · **Decisions** D20, D21, D24, D48, D56, D69–D75, D80, D81
**Contracts** §5

**Status: the parser and both adapters are complete and verified 2026-10-04.** `cargo test -p
clauro-transport` 32/32 on this host. All four named fixtures exist and assert exactly the four
rules they were written for; the chunk-reassembly tests hold at chunk sizes 1, 2, 3, 5, 7, 13 and
survive a multi-byte codepoint split.

**Two criteria were PARTIAL when written. Both are closed as of 2026-10-12; the gap text below is
kept because each one documents a real hole at the time, and each carries its closure line
where it stands.** Per `AGENTS.md` §5a the correction sits beside the claim rather than
being silently deleted.

1. **Retry is a policy, not a retry — CLOSED 2026-10-12.** `retry_delay` was implemented and
   table-tested (`src/retry.rs:22-97`, `tests/retry.rs:11-63`) **with no caller** when this file was
   written — there was then no HTTP send loop anywhere in the repo, and `src/lib.rs:10` still says
   so (that module-doc line is now stale in code; left to its file's owner). Real callers exist
   today: `crates/clauro-transport/src/send.rs:114` (inside `run_with_retry`), `send.rs:196` and
   `send.rs:253` (inside `stream_step`), and the live turn path reaches the first through
   `LiveExchange::step` → `run_with_retry` (`src-tauri/src/turn.rs:489-495`). The "Transport-level
   backoff on 429/5xx honouring `Retry-After`" line below is delivered behaviour, not a promise.
2. **The OpenAI-compatible `notice` is never rendered.** The adapter emits `Ignored` correctly
   (`src/openai_compat.rs:158-175`, `tests/openai_compat.rs:41-61`), but the only consumer of
   `NormalisedEvent` discards it at `crates/clauro-loop/src/run.rs:425-427`. `ContentBlock::Notice`
   and `insert_notice` both already exist and are used for other events — nothing routes `Ignored`
   into it. Both source files already promise 006 will do this (`src/openai_compat.rs:10`,
   `src/anthropic.rs:90-91`), so this is a known gap, not an oversight. (Closed 2026-10-07 — see the
   ticked criterion below; the stale `run.rs` line numbers there are corrected in that criterion.)

**Addendum 2026-10-07, superseded 2026-10-12.** Item 2 was closed on 2026-10-07 (see the ticked
criterion below). Item 1 as originally written here — "`retry_delay` still has no caller outside its
own test … the retry criterion moves to 023 rather than being built twice" — was true on 2026-10-07
and is **false since**: the send loop landed as `crates/clauro-transport/src/send.rs`, whose
callers at `:114`, `:196` and `:253` are the ones named in item 1 above, with the production path
routed through `run_with_retry` from `src-tauri/src/turn.rs:495`.

## Failing tests first

Four fixtures, synthetic, **no live key**:

| Fixture | Asserts |
|---|---|
| `omitted_thinking.sse` | one empty `thinking_delta`, one `signature_delta`, block closes. `D73` |
| `compaction_response.sse` | usage comes from `usage.iterations`; top-level tokens are **zero**. `D70` |
| `dropped_block.sse` | `input_transformations` on `message_start` sets `dropped`. `D71` |
| `unknown_event.sse` | an unrecognised event yields `{t:'ignored'}` and parsing continues. `D80` |

Plus: an event split across a chunk boundary reassembles. Plus: `ping` keeps the connection alive,
`error` terminates with a typed error.

## Do

**Hand-rolled SSE over `reqwest`.** There is no official Anthropic Rust SDK (0.0.8, 2024-09-03) and
both SSE crates are unmaintained. We build on neither. `D24`.

**Four parser rules** (`CONTRACTS.md` §5) — each has a fixture above. **P4 is the one that ships
silently**: a usage footer reading 0/0 looks like a bug in the meter, not a protocol detail.

**Two 400s you will ship if you forget them:**
- `prefix_mismatch_behavior` is **not top-level**. Path is
  `thinking.block_binding.prefix_mismatch_behavior`, under the beta header
  `thinking-binding-controls-2026-08-01`. `D20`.
- **`compaction` and `context_management` cannot be combined on one request.** Headers may coexist;
  the parameters may not. Separate request builders that branch, never merge. `D21`.

**Retry.** Transport-level backoff on 429/5xx honouring `Retry-After`. No agent-level retry concept
— the loop only ever sees a request fail or a stream arrive. `D56`.

**Two adapters** (`D48`): Anthropic, plus one OpenAI-compatible adapter for everything else. The
transcript never branches on provider.

> **The recorded risk, stated plainly:** the OpenAI-compatible surface is validated against a
> third-party server, so coverage of real providers is an **assumption, not a test**. The dialect
> varies in streaming deltas, tool-call framing, and reasoning-token fields. **It degrades visibly** —
> an unrecognised event or an unmappable field becomes a `notice` block saying so. Never render a
> plausible-looking wrong transcript.

**Capability probe.** `capabilities.compaction` decides the compaction path at runtime. **No live
key is needed to choose.** `D75`.

## Acceptance criteria

- [x] Four fixtures pass; all synthetic — all four exist under
      `crates/clauro-transport/tests/fixtures/` (`omitted_thinking.sse`, `compaction_response.sse`,
      `dropped_block.sse`, `unknown_event.sse`, plus `openai_unknown.sse`); tests at
      `tests/parser.rs:45,112,134,153` assert the four named rules each. Hand-written, no key, no
      live host, no real run ids
- [x] `cargo test` needs no network — `crates/clauro-transport/Cargo.toml` has no
      `[dev-dependencies]` at all; every function is pure over injected bytes; `src/lib.rs:53-57`
      states `client()` "performs no I/O". No test in any crate reads a key or opens a socket
- [x] Events split across chunks reassemble — `tests/parser.rs:86-97` asserts identical output at
      chunk sizes 1, 2, 3, 5, 7, 13; `:99-108` keeps a multi-byte `héllo` intact across 3-byte
      splits; `tests/stream_limits.rs` adds four more (split codepoint, oversized line, invalid
      bytes, distinct indices)
- [x] Unknown event → `ignored`, stream continues — `tests/parser.rs:153-170`; also `:197-212`
      (malformed JSON → `Ignored`, not fatal); `src/anthropic.rs:113-117`
- [x] `thinking.block_binding.prefix_mismatch_behavior` sent on the correct path with its header —
      `src/build.rs:64` nests it under `block_binding`, never top-level; beta header at
      `src/build.rs:70-73` (`THINKING_BINDING_BETA` at `:19`); asserted `tests/builders.rs:29-42`
      (`D20`). Value is hardcoded `"drop_block"`; no criterion requires caller-selectability
- [x] Compaction and context-management requests are structurally impossible to combine — two
      disjoint input types with no shared field (`src/build.rs:32-40` vs `:44-49`); the normal
      builder carries `context_management` (`:83-86`), the compaction builder carries `compaction`
      (`:108`); `tests/builders.rs:53-72` asserts the other key is absent. Neither struct has a
      field that could set the other parameter, so the unrepresentability argument holds (`D21`)
- [x] 429/5xx retried with backoff; `Retry-After` honoured — DONE 2026-10-07.
      Status set `408|429|5xx` at `src/retry.rs:28`, `Retry-After` parsed at `:31-35` including
      HTTP-date form (`:45-105`), doubling with a 60 s cap at `:36-40`, `MAX_ATTEMPTS` bounded;
      `tests/retry.rs:11-63` covers all of it. `retry_delay` now has three real callers in
      `crates/clauro-transport/src/send.rs` — `:114` (inside `run_with_retry`), `:196` and
      `:253` (inside `stream_step`), proven by `tests/send.rs`: 429 retried, 400 fails at
      once, attempts capped, cap reports the status actually seen — and the live turn path
      reaches the first via `LiveExchange::step` → `run_with_retry`
      (`src-tauri/src/turn.rs:489-495`, same policy, live path unverified by rule). The old
      "no caller" note is superseded; it lives in the status block above, marked CLOSED.
- [x] OpenAI-compatible adapter renders an unrecognised event as a visible notice — DONE
  2026-10-07 (see Status addendum below). `persist_step` (`run.rs:1126`) routes
  `Ignored { raw_type }` (`run.rs:1213-1228`) to `insert_notice` (`run.rs:1380`);
  proven by `wiring.rs:ignored_events_become_visible_notices`, which failed first
  (0 notices — the silent drop). Pointer history: the drop was at `run.rs:632-634`
  and `insert_notice` at `run.rs:737` when first corrected (2026-10-07); `run.rs`
  has since grown, and the numbers above are current as of 2026-10-12.

**Addendum 2026-10-07 (live smoke, Google Gemini key, Gemma 4).** The "assumption,
not a test" risk above is now measured for one real provider — by a throwaway
script outside the repo (TEMP, deleted after the run; key from a gitignored
`.env`, never printed, never committed, never in a test). Verified live:

- Endpoint `https://generativelanguage.googleapis.com/v1beta/openai`, Bearer
  auth. `GET /models` returns 62 ids including `models/gemma-4-26b-a4b-it`
  and `models/gemma-4-31b-it`. Model ids carry the `models/` prefix and the
  chat endpoint accepts it verbatim.
- `POST /chat/completions` returns the standard envelope (`choices[0]` with
  `finish_reason`/`index`/`message{content,role}`; `usage` with
  `prompt_tokens`/`completion_tokens`/`total_tokens`).
- Streaming is bare `data:` lines plus terminal `data: [DONE]` — no `event:`
  lines. Final chunk carries `finish_reason: "stop"`.
- **Reasoning arrives in-band, and this is the load-bearing fact for the
  translator:** thinking deltas are `<thought>…</thought>` blocks inside
  `delta.content`, marked per-delta by
  `extra_content.google.thought == true`; the closing chunk's content is
  `</thought>4 5 6...` — thought-close and answer text share one delta. A
  translator that splits thinking from text on anything but that marker
  renders reasoning as answer: exactly the plausible-looking wrong transcript
  D80 exists to prevent. Non-thinking deltas carry no `extra_content`.

What this does NOT prove: tool-call framing on this endpoint (no `tools` were
sent - one text turn only), and nothing inside the app (no key is stored on
this host, and the in-app turn path is still unverified end to end).

**2026-10-09 addendum — the translator landed (D119).** Request side:
`crates/clauro-transport/src/openai_request.rs::translate_request` rewrites the loop's
Anthropic body as chat-completions (system → the first message, `input_schema` →
`function.parameters`, `tool_use` → `tool_calls` with JSON-string arguments, `tool_result` →
`role: "tool"` messages directly after the call; `thinking`/`context_management`/beta headers
**dropped, never approximated**) — pinned by `tests/openai_request.rs` (7 tests), and
`assemble_messages` now sends `tool_result` in the following user message, the shape both APIs
require (the latent 400 this task's body-shape notes implied). Routing:
`src-tauri/src/turn.rs::wire_for` picks the wire from the provider row *before* any key is read
or slot claimed; `LiveExchange::build_http` is pure and tested — as-built body with
`x-api-key` on Anthropic, translated body with `Authorization: Bearer` on compat, beta headers
forwarded only where their controls still exist. Response side: the `extra_content.google.thought`
marker recorded above is now parsed — `tests/openai_thought_marker.sse` (synthesised from this
recording, labelled as such, no key used) pins thought→thinking region,
`</thought>`+answer in one delta → split, and markup never reaching either region. The wire now
has an executable witness: `scripts/mock-openai-server.mjs` (`pnpm mock`) — a zero-dependency
loopback server that refuses every request violating the translated shape by field name (D120)
and streams the three e2e scripts (`mock-text` with reasoning deltas, `mock-artifact` and
`mock-question` issuing real tool calls); pinned by `scripts/mock-openai-server.test.mjs`
(8 tests). Still not proven live: tool-call framing on a real endpoint, and any in-app keyed
turn (human-gated).
