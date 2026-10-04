# Task 006 — Transcript, thinking regions, and cancel semantics

**Phase** 1 · **Depends** `005` · **Decisions** D19, D54, D65, D68, D72, D76
**Contracts** §2, §3

## Failing tests first

- **I1** every `tool_use` has a matching `tool_result` with the same id, in the same thread
- **I3** `block.generation` is non-decreasing along `(thread, seq)`
- Cancel mid-turn → every dispatched call closed as `aborted`; **no orphan**
- Cancel mid-turn → completed work **retained**
- A `thinking` block round-trips through the store with its `signature` intact
- A thinking block removed from the **middle** of a run → later blocks are no longer re-sendable

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

- [ ] I1, I3 hold on any transcript fixture
- [ ] Cancel closes every dispatched call; zero orphans
- [ ] Cancel retains completed work
- [ ] `signature` survives a store round-trip
- [ ] Middle-removal invalidation is detected and surfaced
- [ ] One `Thinking` shape renders for both adapters
- [ ] Collapsible inline, collapsed by default
- [ ] Effort changes mid-thread do not error
