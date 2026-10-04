# Task 011 — `web-search` and `web-fetch`

**Phase** 2 · **Depends** `007` · **Decisions** D48, D56 · **Contracts** §3

The two cheapest tools in v1 and the two most often got wrong by clients that *describe* the tool
instead of *steering* selection.

## Failing tests first

- The current year is present in the serialised search prompt — **assert on the request body**, not
  on a comment
- A fetch failure returns `error`; it does not throw
- Fetched HTML → markdown with scripts and styles stripped
- A redirect loop terminates with a typed error, bounded hops
- A response over the size cap is truncated **and the model is told it was**

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

- [ ] Year asserted present in the request body
- [ ] Fetch failures are typed results, never throws
- [ ] HTML → markdown, scripts and styles stripped
- [ ] Redirect loops bounded
- [ ] No description text matches any reference implementation's wording (`D39`, same check as `007`)
- [ ] Oversized responses truncated **and disclosed**
- [ ] Both tool descriptions steering, not merely descriptive
