# Task 008 — Memory tool

**Phase** 2 · **Depends** `007` · **Decisions** D7, D8, D9, D10, D11, D35, D43, D51
**Contracts** §1, §3

## Failing tests first

- `view` on a topic returns the body; `view /memories` lists topics
- `delete /memories` → rejected. `rename` with `old_path = /memories` → rejected
- `../`, `..\`, `%2e%2e%2f`, and a symlink escape → all rejected
- A write whose body looks like a credential → **refused**, silently to the model
- `str_replace` with an absent `old_str` → typed `error`, memory unchanged
- Pause: existing memory retained, **no new writes**, and nothing backfilled on resume
- Per-thread memory-off: that thread writes nothing **and** reads nothing
- Memory in project A is invisible to project B

## Do

Six commands: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`.
`/memories/<path>` → the `key` column. **`category` is the topic.** `D7`.

**A topic store, not a summariser.** The first-party product saves *"a set of individual topics as
you chat, rather than summarizing conversations after they end."* That single line is why there is
no background extractor — **the model writes memory itself**. Our `category` column was already
right; the mechanism in the original plan was wrong.

**Three controls, never collapsed** `D8`:
- account **pause** — keep memory, stop using, stop writing, **not backfilled** on resume
- account **reset** — permanent, irreversible, includes project memories
- per-thread **off** — set before the first message, **locks after**. `D9`

**Sensitive topics** are a fourth control, off by default, with a review notice above the composer
on every save. Never stored even if asked: government ID numbers, criminal history, financial account
numbers, immigration status.

**Memory outlives its source conversation** — deleting a chat does not delete memories derived from
it. `D10`. Adopt knowingly; individual memories are always deletable.

**Per-project scoping** is what makes memory useful rather than a flat notepad. `D35`.

Return strings are **not a contract** — the model reads whatever text we return, so SQLite-native
output is fine.

**Never inject memory into `system` or early messages** (`D11`). Memory is retrieved just-in-time by
the model; preloading it duplicates the protocol we wrote and fights it. That is why `system` stays
frozen at project instructions only.

## Acceptance criteria

- [ ] Six commands work; traversal and root-delete rejected
- [ ] Secret-shaped writes refused
- [ ] Pause / reset / per-thread-off are three distinct behaviours
- [ ] Per-thread toggle locks after first send; crossed-out icon when off, **nothing** when on
- [ ] Sensitive topics off by default; notice on every save when on
- [ ] Project isolation verified both directions
- [ ] Deleting a chat leaves its memories
- [ ] SQLite-native return strings accepted by the model
