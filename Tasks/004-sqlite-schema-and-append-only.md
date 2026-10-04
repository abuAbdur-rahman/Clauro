# Task 004 — SQLite schema and the append-only log

**Phase** 1 · **Depends** `002` · **Decisions** D19, D32, D34, D47, D52, D57, D63, D79
**Contracts** §1, in full

## Failing test first

```
attempt to UPDATE a row in `block`  → assert the update path does not exist
attempt to UPDATE a row in `message` → assert the update path does not exist
```

Not "assert it fails at runtime". **Assert the write path is absent.** If the crate exposes an
`update` on those tables, that is the defect.

## Do

All twelve tables from `CONTRACTS.md` §1, verbatim. `compaction_event` is the
eleventh addition from `D84`; `account_setting` the twelfth, split out of
`memory_setting` because a per-thread scope cannot share a primary key. Then the four that carry real weight:

**`block`** — `boundary`, `is_summary`, `generation`, `signature`, `dropped`. `seq` is per-thread and
**gaps are legal**; a compaction removes a run.

**`usage`** — **two channels.** `summary_tokens` and `summary_used_tokens` are never folded into
`tokenCount`. `D57`. Without the pre-invoke marker, the client re-counts discarded history after a
compact and reports inflated usage. Also `run_id` (a sibling run's summary is not ours to subtract)
and `iterations` (`usage.iterations`, the only source after a compaction — `D70`).

**`tool_result`** — `preview` + `preview_path` + `full_path`, `UNIQUE (thread_id, tool_call_id)`.
Statuses `ok | error | aborted | rejected`. **All four are results.** `D55`.

**`memory`** — a **topic** store, not a conversation log. `revision` bumps on `str_replace`; never
rewrite blind. `sensitive` flag for the opt-in. `D7`, `D8`.

**`attachment`** — `UNIQUE (project_id, content_hash)`. **Never globally unique** — global
content-addressing makes one project observable referencing a file another supplied. `D52`.

**Windows path rules.** Canonicalise → resolve symlinks and junctions → **then** the traversal
check. Checking first is bypassable. Reserved device names rejected case-insensitively **and with any
extension**: `NUL.txt` is `NUL`. Full set `CON PRN AUX NUL COM1–COM9 LPT1–LPT9` plus superscripts
`COM¹²³` / `LPT¹²³`. Budget `MAX_PATH` from the drive root, not from `~`. `D79`.

**Opaque IDs are authoritative.** Slugs are cosmetic and length-capped. A title is not a path — it
contains separators, `..`, reserved names, duplicates, and regenerates. `D32`.

## Acceptance criteria

- [ ] Eleven tables, DDL matching §1
- [ ] No update path on `message` or `block`, enforced by test
- [ ] Every mutable column is in the `CONTRACTS.md` §1 list and has one documented write path
- [ ] `message` and `block` have **zero** mutable columns (the earlier "four mutable tables"
      claim was wrong: `project` and `memory` are mixed, not mutable)
- [ ] `seq` gaps tolerated; `generation` non-decreasing
- [ ] `summary_*` provably separate from ordinary totals
- [ ] `NUL.txt`, `com1`, `COM¹` all rejected
- [ ] A symlink pointing outside the tree is rejected
- [ ] `journal_mode=WAL`, `foreign_keys=ON`
