# Task 028 — Phase 3 gate e2e and persist hardening

**Phase** 3 (gate close-out) · **Depends** `013`, `014` · **Decisions** D113 (plus D65, D68 paths)
**Contracts** §1 (append-only, artifact PK), §2 (I1 pairing), §3 (ToolOutcome, approval states)

**Why this task exists.** `Tasks/014` closed with four honest gaps; two are closable without an
engine and this task closes them: (1) "Nothing calls the drawer yet" — no test proved the
composition tool-result → drawer-store → prepare → envelope → live render; (2) three silent
`let _ =` drops on the exact paths `D65`/`D68` guarantee (`run.rs:493,716,732` — pointers
corrected from the stale `290,513,529` in `PHASES.md:36`, same change). Webview-observable
criteria (no-Tauri-path, denied-fetch-fails, Linux gate firing) stay open to `021` by rule
(`AGENTS.md` §8a); this file does not re-prove them and does not claim to.

**Status: verified 2026-10-06 (Windows host).** Rust e2e 3/3
(`crates/clauro-loop/tests/e2e_phase3.rs`), frontend e2e 3/3
(`src/features/artifact/phase3.e2e.test.tsx`), full workspace + vitest green, clippy/fmt/tsc
clean. Sensitivity proven by mutation: a one-line `source_path` layout sabotage failed all 3
Rust tests for the right reason, then was reverted. Webview-observable criteria stay open to
`021`; the drawer producer stays test-local per **D113**.

## Failing tests first

- [x] Rust: an `artifact` call through the real loop persists a versioned row + source bytes + an
  `ok` tool_result with I1 pairing intact — `e2e_phase3.rs:245`
- [x] Rust: a refresh with the same `artifactId` across two turns commits v2 and leaves v1 bytes
  intact (append-only history through the loop, not just the handler) — `e2e_phase3.rs:292`
- [x] Rust: `artifact` under an `ask` rule holds (`AwaitingApproval`, zero rows), then dispatches
  after `approve_call` and persists — the Phase 3 gate's "runs only after approval" through the
  real artifact handler — `e2e_phase3.rs:333`
- [x] Frontend: a tool result for `artifact` drives `setCompiling` → real `prepareArtifact`
  (injected policy + worker) → drawer `live` with `sandbox="allow-scripts"` and no
  `allow-same-origin` — `phase3.e2e.test.tsx:75`. Failed before the `fetchPolicy`/`createWorker`
  seam existed (drawer spun on `compiling` forever); passes after. Producer test-local per **D113**.
- [x] O1: every `insert_tool_block` / `insert_notice` / `cancel_turn` failure surfaces as
  `LoopError::Store` — `run.rs:500,624,636,799` (`?`), `run.rs:496` (cancel). Deviation
  recorded honestly (see Do): loud turn failure replaces silent loss; the turn does not
  continue past a dead store. Guarded by the e2e row-count/pairing invariants plus the full
  suite green under the new signatures.

## Do

- `crates/clauro-loop/tests/e2e_phase3.rs`: two `Store` handles on one file (never hold a
  store lock across `run_turn` — handlers lock per call), `FsHost` + `register_artifact`,
  scripted `Exchange` (artifact create → refresh → text `end_turn`), filesystem walk for
  `<id>-<version>/source` bytes (X4 style: walk finds the files, not a mock).
- `src/features/artifact/phase3.e2e.test.tsx`: real `useDrawerStore` actions + real
  `prepareArtifact` with injected `fetchPolicy`/`createWorker`; real `ArtifactDrawer`.
  No new production code — **D113**.
- O1 (`run.rs`): `insert_tool_block` and `insert_notice` return `Result<(), LoopError>`;
  `cancel_turn` error propagates via `?`. Deviation recorded honestly: the turn does **not**
  continue past a dead store — loud failure replaces silent loss (there is no durable way to
  record continuing).
- O2: `PHASES.md:36` pointers → `493,716,732`.
- O4: `code = compiled.blocks.join("\n")` (drop the no-op `.map`).
- O3: `pnpm build` re-measure into `docs/build-baseline.md` (main chunk + worker + purify).

## Acceptance criteria

- [x] Artifact turn persists versioned source, bytes match input — `e2e_phase3.rs:245`
  (row `source_path` asserted against the file on disk, bytes asserted equal)
- [x] Refresh bumps version, v1 bytes intact — `e2e_phase3.rs:292`
- [x] Ask-hold-approve persists through the real handler — `e2e_phase3.rs:333`
- [x] Drawer goes `live` from a tool result with host-fixed sandbox tokens —
  `phase3.e2e.test.tsx:75`; refresh re-prepares (`:90`); failure shows reason (`:115`)
- [x] No `let _ =` remains on a `D65`/`D68` persist path — `rg "let _ =" run.rs` empty;
  plus new `Store::artifact_source_path` reader (`clauro-store/src/lib.rs`) tying row↔file
- [x] Bundle re-measured; delta recorded — `docs/build-baseline.md` 028 section
- [x] Phase 3 gate status updated in `PHASES.md` with per-criterion evidence; webview items
  stay open to `021` explicitly (see below)

## CI reds found by this PR and fixed in the same push

CI on PR #4 failed four ways; none was the e2e itself:

- [x] **Linux kill test** (`runner.rs`): `wait_for_pid` validated the pidfile trimmed but
  returned it raw — `echo` leaves `\n`, so `kill -0 "1234\n"` failed and read as "grandchild
  dead". Windows stayed green because only the Linux path reads pids from a file. One-line
  trim on the way out (`runner.rs:233-248`).
- [x] **Windows cwd test** (`runner.rs:88-105`): `cd` prints 8.3 short names (`RUNNER~1`)
  where `canonicalize` resolves long ones (`runneradmin`) — runner-filesystem dependent.
  Both sides canonicalized before comparing.
- [x] **Malware IOC scan**: 4 findings, all false positives on refusal constructs —
  `allow-same-origin` in two negative assertions + one NEVER-prose comment, and a spoofed
  `__TAURI_INTERNALS__.invoke` asserted off-allowlist. Fixed per the script's sanctioned
  path: explicit allowlist entries whose exception lapses if the refusal marker disappears
  (`scripts/malware-ioc-scan.sh` `D2_SANDBOX_ALLOWLIST`/`D6_IPC_ALLOWLIST`; lapse verified
  by deleting a marker and watching it flag).
- [x] **Channel-test CI flake** (`channel.test.ts`, mine): one `tick()` is only enough
  when the runner is idle — under CI load the port hop lands late and `onReady` asserted
  too early (Windows CI red, local green). Positive port assertions now poll bounded
  (`untilSettled`, 1s); negative assertions keep a double tick with the reason stated.
  5/5 local repeats green.
- [ ] **Lint** (`Composer.test.tsx:68`, `027`'s file): `?? ""` on a non-nullable. Still
  red on disk — a removal was applied, verified green, then rewritten by the concurrent
  editor 12s before the push and deliberately NOT re-applied (edit war). Fails `pnpm lint`
  on every job that runs it. Needs 027's owner (or an explicit go-ahead).
- [ ] **safedep external check** (safedep.io, fails in 0s): no workflow file in this repo —
  org-level app, almost certainly misconfigured independent of this PR. Not fixable from
  here; needs an org admin. If it is a required check, every PR is red regardless.

## Post-push Linux finding (WSL2 native run, 2026-10-06)

The first real Linux execution of `kill_group` (GitHub CI never reached it — the pidfile bug
fired first) failed differently: `kill -KILL -<pgid>` **killed the group and still exited 1**
on WSL2's kernel (proven with `setsid` + `ps`: both dead, exit 1). Group-kill exit codes are
therefore not a success signal; `kill_group` on Unix is now effect-based — send KILL best
effort, poll `kill -0 -<pgid>` bounded 5s, `Err` only if members survive
(`crates/clauro-fs/src/runner.rs:226-258`). No production callers exist (tests only), so the
semantic change is test-surface only.
