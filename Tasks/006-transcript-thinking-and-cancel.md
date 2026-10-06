# Task 006 — Transcript, thinking regions, and cancel semantics

**Phase** 1 · **Depends** `005` · **Decisions** D19, D54, D65, D68, D72, D76, D98, D99, D100, D106
**Contracts** §2, §3

**Status: the store-side half is complete and verified 2026-10-05. The UI half does not exist, and
three criteria cannot be met by any amount of backend work.** `cargo test -p clauro-store` 21/21,
`cargo test -p clauro-tools` 42/42, `vitest` 17/17 on this host.

Cancel semantics — the part this task exists for — are genuinely done: `tests/transcript.rs:165-198`
asserts two `aborted` plus one `already_resolved` and an empty unpaired set, and `:201-227` asserts
block and result counts are unchanged, with the append-only scan at `tests/append_only.rs:46` proving
no rollback path can exist. That is `D65` and `D68` paid for properly.

**What is not done, and why it matters more than the count suggests:**

- **`D99` and `D106` are absent from the Rust layer entirely.** Regenerate, edit-resend and
  continue-append have no implementation — grep finds no such symbol in `crates/`, `src/` or
  `src-tauri/`. `queue.rs:57`'s `edit()` only mutates an **unsent** queue chip. These are not
  UI-blocked; they are simply not written. Note that `tests/append_only.rs` proves the *negative*
  (no rewrite path exists) but there is no *positive* test that regenerate appends at a higher
  `seq`, so `D99` currently has no proof in either direction.
- **Middle-removal is detected and nothing surfaces it.** `unbroken_run_end`
  (`clauro-core/src/content.rs:132`, tested at `clauro-core/tests/content.rs:85-90`) has **no caller
  outside its own test**, and `ContentBlock::Notice` is constructed nowhere in the codebase. The
  criterion says "detected **and surfaced**"; only detection exists.
- **No transcript renderer exists.** `src/` is still the Phase-0 shell: `App.tsx` renders a WebView2
  boot gate and a model picker, nothing else. So "collapsible inline, collapsed by default" and
  "HTML purified before render" are **UI-only and unverified** — there is no purifier, no markdown
  pipeline, and no `DOMPurify` dependency in the repo.

One further correction: `crates/clauro-store/src/transcript.rs:45` claims the I1 check "feeds on
fixtures as well as live reads". **No transcript fixtures exist** — the only fixtures in the repo are
the SSE ones under `crates/clauro-transport/tests/fixtures/`. `check_generation_monotonic` is also
never run over `blocks_for_thread` output, only over hand-constructed values
(`tests/transcript.rs:276-289`).

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

- [ ] I1, I3 hold on any transcript fixture — **PARTIAL.** I1 is real and enforced at write time
      (`crates/clauro-store/src/lib.rs:563-586`), checked on three hand-built rows
      (`tests/transcript.rs:119,130,139`) via `find_unpaired_tool_uses`
      (`src/transcript.rs:47`). I3 exists as `check_generation_monotonic` (`src/transcript.rs:72`) but
      is **only ever tested on hand-constructed `FullBlock` values**
      (`tests/transcript.rs:276-289`) — `blocks_for_thread` output never flows through it. And
      "any transcript fixture" has no corpus to test against. See Status
- [x] Cancel closes every dispatched call; zero orphans —
      `crates/clauro-store/src/transcript.rs:180-217`; `tests/transcript.rs:165-198` asserts
      `aborted == 2`, `already_resolved == 1`, `unpaired.is_empty()`; `aborted_carries_aborted_status`
      at `:230`; wired into the turn loop at `crates/clauro-loop/src/run.rs:290` (`D65`)
- [x] Cancel retains completed work — `tests/transcript.rs:201-227` asserts block count and result
      count unchanged after cancel; the append-only scan at `tests/append_only.rs:46` proves no
      rollback path can exist (`D68`)
- [x] `signature` survives a store round-trip — `src/transcript.rs:155-175` selects `b.signature`;
      `tests/transcript.rs:250-271` asserts both the `signature` column and the `payload`; the
      non-empty-signature deserializer at `crates/clauro-core/src/content.rs:53,136-142`
- [ ] Middle-removal invalidation is detected and surfaced — **PARTIAL: detection only.** Detection
      is real — `unbroken_run_end` at `clauro-core/src/content.rs:132`, tested at
      `clauro-core/tests/content.rs:85-90`. **Nothing surfaces it**: that function has no caller
      outside its own test, and `ContentBlock::Notice` is constructed nowhere in `crates/`. See
      Status
- [ ] One `Thinking` shape renders for both adapters — **PARTIAL: shape MET, render unverified.**
      The data shape is genuinely unified and asserted from both adapters' real events —
      `crates/clauro-transport/tests/thinking_shape.rs:87-117` compares `mem::discriminant` for
      equality, over `crates/clauro-core/src/content.rs:47-56`. The verb "renders" needs a
      transcript component, which does not exist. See Status
- [ ] Collapsible inline, collapsed by default — **UNMET, UI-only.** No frontend. The only related
      code is the `ThinkingDisplay { Full, Summary }` enum at `clauro-core/src/content.rs:15-20`:
      no collapse state, no collapsed-by-default, no one-line preview, no side-pane guard. Not
      verifiable on this host (`AGENTS.md` §8a)
- [x] Effort changes mid-thread do not error — `crates/clauro-transport/tests/effort_varies.rs:28-35`
      builds two consecutive budgets successfully; `crates/clauro-loop/tests/prompt.rs:48`;
      `src/thread.test.ts:35-44` asserts `promptHash` is recomputed from unchanged text (`D76`)
- [ ] Regenerate / edit-resend append new rows; history untouched (**D99**) — **UNMET, not
      UI-blocked.** No `regenerate` symbol exists in `crates/`, `src/` or `src-tauri/`.
      `crates/clauro-loop/src/queue.rs:57`'s `edit()` only mutates an **unsent** queue chip. The
      negative half is proven (`tests/append_only.rs`), the positive half does not exist. See Status
- [ ] Continue appends to a truncated turn; regenerate stays for redoing one (**D106**) — **UNMET,
      not UI-blocked.** No continue-append or truncated-turn handling anywhere in the repo. See
      Status
- [ ] Transcript HTML purified before render; streaming reparse at most once per frame (**D100**) —
      **UNMET, UI-only.** Only prose exists (`DECISIONS.md:130,1115`, `CONTRACTS.md:574`,
      `SPEC.md:93`). No purifier, no markdown renderer, no `DOMPurify` dependency, and no `innerHTML`
      anywhere in the repo. Not verifiable on this host
