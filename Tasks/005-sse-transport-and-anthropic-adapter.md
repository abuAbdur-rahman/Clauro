# Task 005 — SSE transport and the Anthropic adapter

**Phase** 1 · **Depends** `004` · **Decisions** D20, D21, D24, D48, D56, D69–D75, D80, D81
**Contracts** §5

**Status: the parser and both adapters are complete and verified 2026-10-04.** `cargo test -p
clauro-transport` 32/32 on this host. All four named fixtures exist and assert exactly the four
rules they were written for; the chunk-reassembly tests hold at chunk sizes 1, 2, 3, 5, 7, 13 and
survive a multi-byte codepoint split.

**Two criteria are PARTIAL, and both are honest deferrals rather than defects — but this file
currently describes them as delivered behaviour, and that is a false claim.** Per
`AGENTS.md` §5a that gets corrected here rather than left standing.

1. **Retry is a policy, not a retry.** `retry_delay` is fully implemented and table-tested
   (`src/retry.rs:22-97`, `tests/retry.rs:11-63`) but **has no caller** — there is no HTTP send loop
   anywhere in the repo, and `src/lib.rs:10` says so outright. The line below saying "Transport-level
   backoff on 429/5xx honouring `Retry-After`" describes behaviour that does not exist yet.
2. **The OpenAI-compatible `notice` is never rendered.** The adapter emits `Ignored` correctly
   (`src/openai_compat.rs:69-76`, `tests/openai_compat.rs:41-61`), but the only consumer of
   `NormalisedEvent` discards it at `crates/clauro-loop/src/run.rs:425-427`. `ContentBlock::Notice`
   and `insert_notice` both already exist and are used for other events — nothing routes `Ignored`
   into it. Both source files already promise 006 will do this (`src/openai_compat.rs:10`,
   `src/anthropic.rs:90-91`), so this is a known gap, not an oversight.

**Addendum 2026-10-07.** Item 2 is closed (see ticked criterion below). Item 1 stands:
`retry_delay` still has no caller outside its own test — its caller is the first real HTTP
send loop, which is the turn driver (023), so the retry criterion moves there rather than
being built twice.

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
- [ ] 429/5xx retried with backoff; `Retry-After` honoured — **PARTIAL. Policy only; no retry.**
      Status set `408|429|5xx` at `src/retry.rs:28`, `Retry-After` parsed at `:31-35` including
      HTTP-date form (`:45-97`), doubling with a 60 s cap at `:36-40`, `MAX_ATTEMPTS` bounded;
      `tests/retry.rs:11-63` covers all of it. **But `retry_delay` has no caller outside its own
      test**, and no HTTP send loop exists (`src/lib.rs:10` defers it). See Status
- [x] OpenAI-compatible adapter renders an unrecognised event as a visible notice — DONE
  2026-10-07 (see Status addendum below). `persist_step` routes `Ignored { raw_type }`
  to `insert_notice` (`run.rs:634-647`); proven by
  `wiring.rs:ignored_events_become_visible_notices`, which failed first (0 notices —
  the silent drop). Stale pointers corrected: the drop was at `run.rs:632-634`, and
  `insert_notice` lives at `run.rs:737`, not the numbers below.
