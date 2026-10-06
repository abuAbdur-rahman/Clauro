# Task 004 — SQLite schema and the append-only log

**Phase** 1 · **Depends** `002` · **Decisions** D19, D32, D34, D47, D52, D57, D63, D79
**Contracts** §1, in full

**Status: complete and verified 2026-10-05. All nine criteria discharged.** `cargo test -p
clauro-store` 25/25, `cargo test -p clauro-fs` 8/8, both on this host. The `summary_*` separation is
the strongest proof in the repo — the SUM query names only the four ordinary columns
(`crates/clauro-store/src/lib.rs:629-644`), so re-folding is structurally impossible rather than
merely untested.

**Two corrections to this file, both made in this change.** The acceptance list said "Eleven tables";
the schema has **twelve**, in both `crates/clauro-store/src/lib.rs:22-161` and `CONTRACTS.md` §1,
asserted by name at `crates/clauro-store/tests/schema.rs:111-134`. The "Do" section below was always
right. Separately, the Windows path criteria are discharged by **`clauro-fs`, not `clauro-store`** —
`crates/clauro-fs/tests/paths.rs` — which this file never said. (`ARCHITECTURE.md` §4 carried the same
"Eleven tables" error and was corrected alongside.)

**One live gap, now closed.** `tests/append_only.rs:91-94` widens its mutable-column allowlist to
include `account_setting.*`, with the justification in a comment at `append_only.rs:74-76`, while
`CONTRACTS.md` §1 did not list it — so the enforcement test and the document disagreed. Fixed in this
change: `CONTRACTS.md` §1 now lists `account_setting.*` and no longer duplicates `thread.memory_off`
(it appeared twice, at `:226` and `:229`). The allowlist and the contract now agree.

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

- [x] Twelve tables, DDL matching §1 — `crates/clauro-store/src/lib.rs:22-161`;
      `tests/schema.rs:111-134` asserts the exact twelve names; `CONTRACTS.md` §1 lists the same
      twelve. **Corrected from "Eleven"** — see Status
- [x] No update path on `message` or `block`, enforced by test —
      `tests/append_only.rs:47-70` lexically scans `src/` for `UPDATE` against either table and for
      `update_*`/`delete_*` helpers; it passes. This is the "assert the write path is absent" form
      the task demands, not "assert it throws". All ten `UPDATE` statements in the crate are on
      `project`/`thread`/`memory`/`artifact` (`lib.rs:838,847,856,865,874,889,907,922,996,1034`).
      Residual gap: the scan is per-line, so a multi-line statement or an `INSERT OR REPLACE` on
      either table would evade it — neither exists today
- [x] Every mutable column is in the `CONTRACTS.md` §1 list and has one documented write path —
      12 setters each carry a doc comment naming the column
      (`lib.rs:836,845,854,863,872,882,900,915,991,1004,1019,1032`), exercised end to end at
      `tests/schema.rs:291-352`, allowlist enforced by `append_only.rs:73-142`. The allowlist was
      **wider than the doc** — it included `account_setting.*` (`append_only.rs:91-94`, justified at
      `:74-76`) while `CONTRACTS.md` §1 omitted it. **`CONTRACTS.md` corrected in this change**; the
      two now agree, and the duplicated `thread.memory_off` entry is gone. See Status
- [x] `message` and `block` have **zero** mutable columns (the earlier "four mutable tables"
      claim was wrong: `project` and `memory` are mixed, not mutable) — `tests/append_only.rs:47-70`;
      DDL at `lib.rs:44-65` has no mutable column; `CONTRACTS.md:235` agrees; the rejection of the
      old claim is recorded at `append_only.rs:74-76` and `CONTRACTS.md:218-220`
- [x] `seq` gaps tolerated; `generation` non-decreasing — `tests/schema.rs:194-205` (seq 1 then 5
      both persist), `:207-233` (regression → typed error); write-time guard at `lib.rs:563-586`,
      error variant at `lib.rs:177`; `compaction_event` generation is strictly +1
      (`tests/schema.rs:412-439`)
- [x] `summary_*` provably separate from ordinary totals — `tests/schema.rs:235-264` writes
      9 999 / 8 888 and reads totals back as 100/50/10; `lib.rs:629-644`'s SUM query names only the
      four ordinary columns, so the separation is structural (`D57`)
- [x] `NUL.txt`, `com1`, `COM¹` all rejected — **`clauro-fs`, not `clauro-store`**:
      `crates/clauro-fs/tests/paths.rs:39-72` covers `NUL.txt` (`:44`), `com1` (`:53`), `COM¹`
      (`:57`), plus `com²`, `LPT³`, `lpt¹.txt`; near-miss guard at `:74-99`. Passes on this host
- [x] A symlink pointing outside the tree is rejected — `crates/clauro-fs/tests/paths.rs:163-195`.
      **Caveat worth carrying:** the test degrades to a containment-only assertion when the host
      cannot create symlinks (`paths.rs:180-188`), so it can report green on a weaker claim. This
      host has Developer Mode on, so the real branch ran; any CI verdict must confirm the same
- [x] `journal_mode=WAL`, `foreign_keys=ON` — set per-connection at `lib.rs:432-433` (not once at
      creation); asserted file-backed at `tests/schema.rs:184-190`, because `:memory:` stays
      `memory` (`lib.rs:450-455`)
