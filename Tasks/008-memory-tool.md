# Task 008 — Memory tool

**Phase** 2 · **Depends** `007` · **Decisions** D7, D8, D9, D10, D11, D35, D43, D51
**Contracts** §1, §3

**Status: backend complete and verified 2026-10-05. No UI exists, so two criteria are unverified.**
`cargo test -p clauro-tools` 58/58 on this host, 15 of them in `tests/memory.rs`.

All three controls are genuinely distinct and separately tested — pause blocks reads *and* writes
(`src/memory.rs:96-101,146`, matching `D8`'s "stop using"), reset requires `confirm: true` and wipes
across all projects (`:379-390`), and per-thread off blocks reads and writes too (`:86-88`). The
per-thread lock is real: `set_thread_memory_off` returns `StoreError::Locked` once
`thread_message_count > 0` (`crates/clauro-store/src/lib.rs:991-1000`), and it is the only writer of
`memory_off`, so there is no back door.

**Three corrections to this file.** All three claims below overstate what the code does, and
`AGENTS.md` §5a says a false claim in a spec is a bug.

1. **There are seven commands, not six.** `reset` exists as a seventh (`src/memory.rs:135`, schema
   enum at `src/registry.rs:90`), and the tool's own message at `memory.rs:122` lists seven. The six
   below are the memory operations; `reset` is a control.
2. **"SQLite-native output" is not what it returns.** Line 42 below says return strings "are not a
   contract — SQLite-native output is fine". The actual returns are hand-built formatting
   (`memory.rs:31-37`, `:239`, `:274`, `:189`), which is fine in itself, but the doc's framing
   implies a behaviour that does not exist.
3. **Symlink escape is not tested here, and that is deliberate.** It routes through
   `clauro_fs::check_relative_path` (`memory.rs:56`), which the store tests cover, and `memory.rs:53-55`
   declares symlink escape N/A for a virtual store. Traversal *is* tested — `tests/memory.rs:128-149`
   covers `../x`, `..\x`, `%2e%2e%2f`, `%2E%2E%5C` and `/memories/../../x`.

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

- [x] Six commands work; traversal and root-delete rejected — all six exercised at
      `tests/memory.rs:93,114,196,230,252,285`; dispatch at `src/memory.rs:149-156`. Root-delete
      refused at `memory.rs:330` and rename-from-root at `:352`, tested `tests/memory.rs:114-125`.
      Traversal refused via `clauro_fs::check_relative_path` (`memory.rs:56`), tested
      `tests/memory.rs:128-149`. See Status on the seventh command (`reset`)
- [x] Secret-shaped writes refused — `memory.rs:209` (create), `:276` (`str_replace`), `:314`
      (`insert`), single opaque `REFUSED` const at `:19`; `tests/memory.rs:153-179` covers all three,
      `tests/secret.rs` 4/4, and a benign look-alike guard at `tests/memory.rs:182` prevents
      false positives (`D43`)
- [x] Pause / reset / per-thread-off are three distinct behaviours — pause `memory.rs:96-101,146`
      (blocks reads as well as writes, matching `D8`); reset `memory.rs:379-390` (requires
      `confirm: true`, wipes all projects, returns a count); per-thread off `memory.rs:86-88`.
      Tests `tests/memory.rs:302,343,380` (`D8`, `D9`)
- [ ] Per-thread toggle locks after first send; crossed-out icon when off, **nothing** when on —
      **split verdict. Lock: MET.** `crates/clauro-store/src/lib.rs:991-1000` returns
      `StoreError::Locked` when `thread_message_count > 0`; it is the only writer of `memory_off`, so
      no raw setter exists (doc comment at `lib.rs:987-990`); tested `tests/memory.rs:412-431`.
      **Icon: UNMET, UI-only** — no memory UI exists at all in `src/`. Not verifiable on this host
- [x] Sensitive topics off by default — hidden from listing (`memory.rs:109`) **and** from a direct
      `view` (`:186`), returning "no such topic" rather than a permission error — so the flag is not
      probeable; DDL defaults at `crates/clauro-store/src/lib.rs:105,115,120`; tested
      `tests/memory.rs:480-505`
- [ ] Sensitive topics off by default; notice on every save when on — **backend half MET, notice
      UNMET.** The default and the hide-from-view are done and tested as above; **the review notice
      above the composer does not exist** — there is no composer. `DESIGN.md` specifies it, no code
      does. Not verifiable on this host (`AGENTS.md` §8a)
- [x] Project isolation verified both directions — `memory.rs:395-407`; store scope filter
      `crates/clauro-store/src/lib.rs:703-731`; `tests/memory.rs:436-478` asserts A-sees-only-A,
      B-sees-only-B, and the same path in both projects as separate rows (`D35`)
- [ ] Deleting a chat leaves its memories — **PARTIAL: unbreakable by construction, never observed.**
      `tests/memory.rs:507-533` asserts the `memory` DDL contains no `thread` string, and
      `crates/clauro-store/src/lib.rs:99-110` confirms it; there is no `delete_thread` in the store at
      all, so nothing can cascade. That is a structural guarantee, not an observed one — an actual
      chat delete has never run. `Tasks/019` owns it (`D10`)
- [ ] SQLite-native return strings accepted by the model — **NOT RUN ON THIS HOST, and misdescribed.**
      The strings are hand-formatted, not SQLite-native (`memory.rs:31-37,239,274,189`) — see Status.
      The "accepted by the model" half needs a live key and a real turn, so it is unproven by design.
      Per the repo rule, a test needing a key is a test that silently stops running
