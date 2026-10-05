# Task 011 — `web-search` and `web-fetch`

**Phase** 2 · **Depends** `007` · **Decisions** D48, D56 · **Contracts** §3

The two cheapest tools in v1 and the two most often got wrong by clients that *describe* the tool
instead of *steering* selection.

**Status: backend complete and verified 2026-10-05 on this Windows host.**
`cargo test -p clauro-tools --test web` 9/9. Both handlers reachable — the
loop dispatches through the registry (`run.rs:263`), so `web-search` and
`web-fetch` are callable. Unwired/untestable headless: `reqwest_getter`
constructs but never touches a live host (no network in tests, by rule); the
DDG anchor scan pins a shape assumption that provider drift can rot — it
fails visibly as `NoResults` when it does.

## Failing tests first

- [x] The current year is present in the serialised search prompt — **assert on the request body**, not
  on a comment — `crates/clauro-tools/tests/web.rs:77`
- [x] A fetch failure returns `error`; it does not throw — `web.rs:121` (search), `:206` (fetch + scheme)
- [x] Fetched HTML → markdown with scripts and styles stripped — `web.rs:134`
- [x] A redirect loop terminates with a typed error, bounded hops — `web.rs:155` (A↔B loop, revisit detection)
- [x] A response over the size cap is truncated **and the model is told it was** — `web.rs:181`

## Do

**`web-search`** — PORTED *behaviour*, ORIGINAL wording. The behaviour is one line and it outranks
the rest: **state the current year explicitly and require it in the query.** A model searching with a
stale year is the single most common failure, and one line in the prompt fixes it. Highest
signal-to-noise finding across all four references.

**`web-fetch`** — PORTED *behaviour*, ORIGINAL wording: **when another present tool is better
targeted to the task, or has fewer restrictions, prefer it.** Most clients describe what a tool
does; this tells the model when **not** to use it, which is what actually improves selection between
overlapping tools.

**The quotes that appeared here in an earlier draft are removed on purpose.** They were verbatim
reference-implementation prompt text, and `Tasks/007` already requires that no description match any
reference's wording. Two MIT repos carry first-party Anthropic prompt text verbatim inside them and
MIT cannot relicense it (`D39`, `AGENTS.md` §4). The *design* is portable; the *wording* is not.
Both prompts here must be written from scratch and asserted against the same no-matching-wording
check `Tasks/007` uses.

Neither tool writes to disk (`writesToDisk: false`), so neither enters the consent model.

## Acceptance criteria

- [x] Year asserted present in the request body — `web.rs:77`
- [x] Fetch failures are typed results, never throws — `web.rs:121`, `:206`
- [x] HTML → markdown, scripts and styles stripped — `web.rs:134` (+ DDG anchor shape pinned at `:233`)
- [x] Redirect loops bounded — `web.rs:155`
- [x] No description text matches any reference implementation's wording (`D39`, same check as `007`) — blurbs pinned in `crates/clauro-tools/tests/descriptions.rs`, human-read; both steer ("pass the current year", "prefer a more targeted tool")
- [x] Oversized responses truncated **and disclosed** — `web.rs:181`
- [x] Both tool descriptions steering, not merely descriptive — same pin (see above)
