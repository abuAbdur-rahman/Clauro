# Task 006 — Transcript, thinking regions, and cancel semantics

**Phase** 1 · **Depends** `005` · **Decisions** D19, D54, D65, D68, D72, D76, D98, D99, D100, D106
**Contracts** §2, §3
**Status: the store half, the cancel semantics, and the renderer all exist and are verified
2026-10-07.** `cargo test --workspace --locked` 259/259, `vitest` 167/167 on this host.

**Addendum 2026-10-07 (renderer + streaming).** The UI half now exists. What landed, and what each
piece is actually proven to do:

- **The turn loop can stream.** `Exchange::step` (`crates/clauro-loop/src/run.rs`) takes a
  `&mut dyn FnMut(NormalisedEvent)` sink and is called once per event as the event is produced.
  The returned `Vec` is still the persistence source, so storage is unchanged and a caller passing
  `&mut |_| {}` sees the pre-existing behaviour. Before this, a step was only observable after the
  provider finished — nothing could render mid-response. `crates/clauro-loop/tests/streaming.rs`
  (3 tests) failed first on the two signatures and now pins: events reach the sink before the step
  returns; deltas arrive before `BlockStop`; three deltas still collapse to **one** persisted text
  block.
- **The send loop exists.** `crates/clauro-transport/src/send.rs` — `ByteSource` + `stream_step`,
  which is what `retry_delay` had no caller for (`Tasks/005`). `tests/send.rs` (6 tests) drives
  fixture bytes through it: events reach the sink as bytes arrive, chunk size does not change the
  event sequence, a 429 retries, a 400 fails immediately, attempts are capped at `MAX_ATTEMPTS`, and
  **the cap reports the status actually seen** (a hardcoded 429 would misdescribe a 503 outage).
- **Store rows → contract blocks.** `crates/clauro-loop/src/seam.rs`, `blocks_to_contract`.
  `tests/seam.rs` (8 tests): every kind maps to exactly one variant; `tool_result` keeps
  `preview_path` (D27); all four statuses survive distinctly; a malformed payload or unknown kind
  degrades to a `Notice` naming the row **id**, never a panic and never a silent drop (D55).
- **The renderer exists.** `src/features/transcript/TranscriptView.tsx` — assistant text is a
  ghost unframed row, the user turn is the only framed row, `ThinkingRegion` is collapsible inline
  and collapsed by default, `ToolRow` is one line until expanded. `TranscriptView.test.tsx`
  (16 tests) pins each of those, including that no delete/remove affordance exists (D19) and that
  nothing renders as an `aside` (D54).
- **D100 is met on both halves.** `src/features/transcript/markdown.ts` — `marked` to HTML, then
  DOMPurify, and the sanitised string is what the function returns, so a caller cannot obtain
  unsanitised output. `FrameCoalescer` emits at most once per frame. `markdown.test.ts` (12 tests)
  asserts against the **parsed DOM** rather than substrings, because `onload` legitimately survives
  inside escaped text and a substring match cannot tell that from a live attribute.

**Corrections to earlier notes in this file.** The previous version said "no `DOMPurify` dependency
in the repo" — false, `package.json` has carried one since `Tasks/014`. It also said no markdown
pipeline existed; `marked` is now adopted, with the rejected alternative recorded in
`TECH_STACK.md` §7.2 per §6.1 rule 3.

**Still open after 2026-10-09 (one item, and it needs a human):**

- **A live turn with a stored key.** Every layer except the socket is proven;
  the socket needs a real key, and no test may use one by rule.

**Closed 2026-10-09:**

- **Middle-removal is surfaced, not just detected.** `assemble_messages` now
  computes the unbroken thinking prefix via `unbroken_run_end` (its first
  production caller), withholds later blocks from the request, and the driver
  inserts one deduplicated `notice` row naming the withheld count
  (`crates/clauro-loop/tests/thinking.rs`, 3 tests, all failed first).
- **I1/I3 run over a fixture corpus.** `crates/clauro-store/tests/fixtures/
  transcripts/*.json` (basic, multi-turn, broken-pairing, regression) seeded
  through the real write path and checked over real `blocks_for_thread`
  output (`tests/transcript_fixtures.rs`, 3 tests). The regression file
  additionally proves I3 is *enforced* at write time (`GenerationRegression`).
- **A host now drives turns from the UI (2026-10-07).** `src-tauri/src/turn.rs`:
  `turn_start` validates, reads the key from the keychain, ensures the thread row, and spawns a
  dedicated thread running `run_turn` through `LiveExchange` (blocking Anthropic SSE, `retry_delay`
  on failure); the sink maps each event to `TurnEvent` and emits `clauro://turn-event` as it
  arrives, with `clauro://turn-done` terminal. `src/features/turn/ChatView.tsx` accumulates text
  deltas into the streaming row, offers Stop (`turn_stop` sets the shared flag; the loop closes
  open calls as `aborted` and keeps completed work), and re-reads via `transcript_read` on mount
  and on every done — the store is the record, the events are hints. What "both adapters" still
  excluded at the time — a non-Anthropic provider failing typed `UnsupportedProvider` — closed
  2026-10-09 (D119): the provider row picks the wire (Anthropic posts as built; compat rows post
  the translated body to their configured endpoint with bearer auth), the second live path is no
  longer absent, and only a compat row with no endpoint URL remains typed-refused. The parser was
  already tested at the transport layer and now also parses the Gemini thought marker
  (`tests/openai_thought_marker.sse`).

Cancel semantics — the part this task exists for — remain genuinely done and untouched by this
change: `tests/transcript.rs:165-198` asserts two `aborted` plus one `already_resolved` and an empty
unpaired set, `:201-227` asserts block and result counts are unchanged, and the append-only scan at
`tests/append_only.rs:46` proves no rollback path can exist. That is `D65` and `D68` paid for.

**Addendum 2026-10-07 (D99/D106 backend).** `TurnLoop::regenerate_last` re-reads the latest stored
user text and runs it as a new turn (empty history fails typed `Store(NotFound)`);
`TurnLoop::continue_turn` shares the D19 check and the step loop via an extracted `drive_turn` but
inserts no user message. Three tests in `crates/clauro-loop/tests/run.rs`, all failed first (no such
methods). UI triggers stay open; edit-resend needs no new code (`run_turn` with edited text,
append-only by construction).

## Failing tests first

- **I1** every `tool_use` has a matching `tool_result` with the same id, in the same thread
- **I3** `block.generation` is non-decreasing along `(thread, seq)`
- Cancel mid-turn → every dispatched call closed as `aborted`; **no orphan**
- Cancel mid-turn → completed work **retained**
- A `thinking` block round-trips through the store with its `signature` intact
- A thinking block removed from the **middle** of a run → later blocks are no longer re-sendable
- Regenerate-last appends a new assistant message at a higher `seq`; no row is rewritten (**D99**)
- Continue on a truncated turn appends to the same turn instead of regenerating (**D106**)
- Edit-resend appends the edited user message plus the fresh answer as new rows (**D99**)
- Transcript HTML carrying `<script>` or an event-handler attribute renders inert after purify (**D100**)
- **A step's events reach a sink before the step returns** — the property that makes a turn
  renderable rather than appearing whole at `end_turn`
- **Every stored `kind` maps to one contract variant**, and an unreadable payload degrades to a
  visible notice rather than a panic or a silent drop

## Do

**One content-block shape for both providers** (`CONTRACTS.md` §2). The transcript cannot branch on
provider — that is what `D54` requires.

**Thinking renders as one collapsible inline region.** Collapsed by default, one-line preview,
never a side pane: a pane competes with the artifact drawer during exactly the turns where both
matter. `D54`.

**Cancel semantics** — the part that is easy to get wrong:
- Every **dispatched** call gets a result, including cancelled ones. `D65`.
- An orphaned `tool_use` with no result is exactly the unbalanced pair that `D18`/`D61` exist to
  prevent; it surfaces only after compaction or on resume, which is the worst place to find it.
- **Stop keeps completed work.** Rollback would discard work already done *and* contradict `D65`.
  `D68`.

**Thinking is an unbroken run.** `signature` must be captured — a persister that stops at
`content_block_stop` replays blocks that fail verification. `D72`. And note what **may** vary
mid-thread: thinking effort, `max_tokens`, `tool_choice`, `metadata`, `thinking.display`,
`cache_control` are all outside the prefix check. `D76`. `D19`'s freeze constrains `system` and
`tools` only.

## Acceptance criteria

- [x] I1, I3 hold on any transcript fixture — DONE 2026-10-09. The corpus lives at
      `crates/clauro-store/tests/fixtures/transcripts/` (`basic-turn`, `multi-turn`,
      `broken-pairing`, `generation-regression` JSON), seeded through the real write path and
      checked over real `blocks_for_thread` output (`tests/transcript_fixtures.rs`, 3 tests).
      Valid fixtures hold both invariants; the broken one is detected (`unpaired ==
      ["call-x"]`); the regression file proves I3 is *enforced* at write time with a typed
      `GenerationRegression` refusal — the row never lands
- [x] Cancel closes every dispatched call; zero orphans —
      `crates/clauro-store/src/transcript.rs:180-217`; `tests/transcript.rs:165-198` asserts
      `aborted == 2`, `already_resolved == 1`, `unpaired.is_empty()`; `aborted_carries_aborted_status`
      at `:230`; wired into the turn loop at `crates/clauro-loop/src/run.rs` `drive_turn` (`D65`)
- [x] Cancel retains completed work — `tests/transcript.rs:201-227` asserts block count and result
      count unchanged after cancel; the append-only scan at `tests/append_only.rs:46` proves no
      rollback path can exist (`D68`)
- [x] `signature` survives a store round-trip — `src/transcript.rs:155-175` selects `b.signature`;
      `tests/transcript.rs:250-271` asserts both the `signature` column and the `payload`; the
      non-empty-signature deserializer at `crates/clauro-core/src/content.rs:53,136-142`. Also
      asserted across the new seam: `tests/seam.rs::thinking_row_keeps_its_signature`, and a
      thinking row stored **without** a signature degrades to a notice rather than becoming a
      re-sendable-looking block
- [x] Middle-removal invalidation is detected and surfaced — DONE 2026-10-09.
      `assemble_messages` computes the unbroken thinking prefix via `unbroken_run_end`
      (its first production caller — detection finally has one), withholds later blocks from
      the request, and the driver inserts one deduplicated notice row naming the withheld
      count (`THINKING_GAP_MARKER`). `crates/clauro-loop/tests/thinking.rs`: withhold +
      surface, dedup across turns, whole-run control — all three failed first
- [x] One `Thinking` shape renders for both adapters — shape **and** render, both asserted. The data
      shape was already unified and is asserted from both adapters' real events —
      `crates/clauro-transport/tests/thinking_shape.rs:87-117` compares `mem::discriminant` over
      `crates/clauro-core/src/content.rs:47-56`. The render is now
      `src/features/transcript/TranscriptView.tsx::ThinkingRegion`, and
      `TranscriptView.test.tsx::renders_the_same_shape_for_both_providers` rerenders a
      `display: "summary"` block and asserts the same collapsed affordance — the view branches on
      nothing but `kind`
- [x] Collapsible inline, collapsed by default — `ThinkingRegion`
      (`src/features/transcript/TranscriptView.tsx`), `aria-expanded` on the toggle and `false` on
      first render. Pinned by `TranscriptView.test.tsx`: `is_collapsed_by_default`,
      `shows_only_the_first_line_while_collapsed`, `expands_and_collapses_inline`, and
      `never_renders_as_a_side_pane` (asserts no `aside` and no `role="complementary"` — `D54`)
- [x] Effort changes mid-thread do not error — `crates/clauro-transport/tests/effort_varies.rs:28-35`
      builds two consecutive budgets successfully; `crates/clauro-loop/tests/prompt.rs:48`;
      `src/thread.test.ts:35-44` asserts `promptHash` is recomputed from unchanged text (`D76`)
- [x] Regenerate / edit-resend append new rows; history untouched (**D99**) — backend, DONE
      2026-10-07: `TurnLoop::regenerate_last` re-reads the latest stored user text and runs it as a
      new turn; a thread with no user text fails typed `Store(NotFound)`. Three tests in
      `crates/clauro-loop/tests/run.rs`. UI triggers still absent
- [x] Continue appends to a truncated turn; regenerate stays for redoing one (**D106**) — backend,
      DONE 2026-10-07: `TurnLoop::continue_turn` shares the D19 check and the extracted `drive_turn`
      but inserts no user message. UI trigger still absent
- [x] Transcript HTML purified before render; streaming reparse at most once per frame (**D100**) —
      `src/features/transcript/markdown.ts`: `renderMarkdown` parses with `marked` then returns
      **only** `DOMPurify.sanitize(...)`, so unsanitised output is unreachable from it;
      `FrameCoalescer` buffers deltas and emits once per frame. `markdown.test.ts` (12 tests)
      asserts inertness against the **parsed DOM** — no `script`/`iframe`/`style`/`object`/`embed`/
      `form` elements and no attribute beginning with `on` — plus
      `never_returns_a_live_dangerous_node_for_adversarial_input`. The purifier is loaded
      **dynamically**, for the same bundle reason `features/artifact/sanitize.ts` documents, and
      `ALLOWED_URI_REGEXP` is deliberately unset — the default URI regexp already refuses
      `javascript:`, which is asserted directly rather than trusted