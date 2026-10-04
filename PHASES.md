# Clauro — PHASES.md

**Seven phases, twenty-three tasks.** Each phase lists its tasks, its gate, and what it unblocks.
Sequencing rationale is in `PLAN.md` §4.

Every task is test-first and contract-anchored (`AGENTS.md` §6). A task's file names the failing
test that must exist before implementation.

---

## Phase 0 — Ground truth

**Purpose:** learn the one thing we cannot research, and stand up a build that can be tested without
a display.

| Task | Contract | D-refs |
|---|---|---|
| `Tasks/001-dual-engine-sandbox-spike.md` | — (produces a verdict, not code) | D2, D6, D45, D77 |
| `Tasks/002-workspace-skeleton-and-ci.md` | — | D50 |
| `Tasks/003-keyring-and-model-catalogue.md` | `ProviderAdapter.limits` | D19, D23, D49, D50, D53, D76 |

**Gate:** `001` verdict written and committed. `cargo test` and `vitest` green headless on all four CI
jobs, including **both floors**.

**Unblocks:** everything. `Tasks/013` waits on the `001` verdict; everything else waits on `002`.

> **`Tasks/001` is the highest-leverage two days in the project.** It answers a question no document
> answers, and it gates a release decision (`D45`). Run it first, on purpose, while the answer is
> still cheap.

---

## Phase 1 — Shell

**Purpose:** a real streaming conversation, on both providers, with a cancel that loses nothing.

| Task | Contract | D-refs |
|---|---|---|
| `Tasks/004-sqlite-schema-and-append-only.md` | §1 | D7, D8, D19, D32, D34, D47, D52, D55, D57, D63, D70, D79 |
| `Tasks/005-sse-transport-and-anthropic-adapter.md` | §5 | D20, D21, D24, D48, D56, D69, D70, D71, D73, D75, D80, D81 |
| `Tasks/006-transcript-thinking-and-cancel.md` | §2, §3 | D18, D19, D54, D61, D65, D68, D72, D76 |

**Gate:** a streaming turn renders on both adapters; stop mid-turn keeps completed work and closes
every dispatched call; reasoning is one collapsible region for both providers.

**Unblocks:** Phase 2 (the loop needs a surface to run against), Phase 4 (the meter needs a real
transcript to measure).

---

## Phase 2 — Tool loop

**Purpose:** the model can call tools, and every failure arrives as a result rather than a crash.

| Task | Contract | D-refs |
|---|---|---|
| `Tasks/007-tool-registry-and-permissions.md` | §3 | D19, D26, D27, D39, D51, D55 |
| `Tasks/023-turn-loop-and-system-prompt.md` | §2, §3 | D7, D11, D19, D27, D33, D39, D51, D55, D65, D67, D68, D76, D82, D85 |
| `Tasks/008-memory-tool.md` | §1, §3 | D7, D8, D9, D10, D11, D35, D43, D51 |
| `Tasks/009-question-tool.md` | §2, §3 | D40, D41, D42, D43 |
| `Tasks/010-fs-tool.md` | §3 | D31, D32, D33, D34, D39, D44, D47, D52, D79 |
| `Tasks/011-web-search-and-fetch.md` | §3 | D39, D48, D56 |

**Gate:** the turn loop runs to `end_turn`; the five model-callable tools built so far (`memory`,
`question`, `fs`, `web-search`, `web-fetch`) are callable; `compact` is absent from the request
schema; no handler throws. `artifact` and `bash` arrive in Phase 3, so **two of the eight tools are
not yet callable at this gate** — that is expected, not a failure.

**Read order inside this phase:** `007` → `023` → the handlers. `023` owns the loop that drives every
handler, so a handler written before it has no defined caller.

**Unblocks:** Phase 3 (`fs` proves the workspace tree before `bash` exists; `artifact` needs the
loop), Phase 4 (compaction needs tools to compact around).

---

## Phase 3 — Gated features

**Purpose:** the two things with real blast radius. Both are gated for a reason.

| Task | Contract | D-refs | Gate |
|---|---|---|---|
| `Tasks/012-bash-tool.md` | §3 | D28, D29, D30, D46, D66, D67 | D19, D28, D29, D30, D46, D55, D66, D67 |
| `Tasks/013-artifact-drawer.md` | §1, §2 | D1, D2, D3, D45, D63, D77 | D1, D2, D3, D45, D63, D77 |
| `Tasks/014-artifact-compile-and-channel.md` | §3 | D4, D5, D6, D12 | D2, D4, D5, D6, D12, D78 |

**Gate:** artifacts render live and the iframe has no reachable path to app internals; a denied
network request from inside an artifact fails; `bash` runs only after approval.

**Unblocks:** Phase 5 (the drawer is the visual centrepiece of the shell).

---

## Phase 4 — Context

**Purpose:** the app survives a long conversation, on any provider, without lying about cost.

| Task | Contract | D-refs |
|---|---|---|
| `Tasks/015-token-meter.md` | §4 | D17, D25, D64, D82 |
| `Tasks/016-client-side-compaction.md` | §4 | D12, D13, D15, D16, D17, D18, D57, D58, D61, D63, D64, D65, D70 |
| `Tasks/017-anthropic-compaction-paths.md` | §5 | D14, D16, D21, D22, D69, D70, D74, D75, D81 |

**Gate:** compaction fires on `min(ratio, usable − headroom)`; a summariser that changes nothing
cannot authorise a retry; usage after compaction reads `usage.iterations`, not the zeroed fields; no
`tool_use` is ever split from its result.

**Unblocks:** nothing structurally — but a v1 without this fails on any long thread.

---

## Phase 5 — Product surface

**Purpose:** the features that make it a *product* rather than a shell.

| Task | Contract | D-refs |
|---|---|---|
| `Tasks/018-projects-and-memory-ui.md` | §1 | D8, D9, D32, D35, D36, D37, D52 |
| `Tasks/019-incognito-export-and-retention.md` | §1 | D10, D19, D37, D38, D57, D67 |
| `Tasks/020-themes-hotkey-and-command-palette.md` | — | D42, D44, D66 |

**Gate:** a user completes a real task end to end and can delete every byte.

**Unblocks:** Phase 6.

---

## Phase 6 — Release

**Purpose:** prove it on the engines people actually run.

| Task | Contract | D-refs |
|---|---|---|
| `Tasks/021-platform-floors-and-linux-gate.md` | §7 | D2, D45, D46, D50, D77, D79 |
| `Tasks/022-packaging-and-dependency-audit.md` | — | D4, D23, D24, D39, D49, D53, D59, D60 |

**Gate:** **both floors** pass, not just the primaries. Installers exist for Windows and Linux.
Dependency audit confirms nothing was ported from LobeHub or from proprietary wording.

**A floor failure is a release blocker, not a warning.** The floors are where the sandbox guarantee
gets falsified. **D50.**

---

## Critical path

```
001 ──► 013 ──► 014 ──┐
002 ──► 003 ──► 004 ──┼─► 005 ──► 006 ──► 007 ──┬─► 008 ─┐
                   │                          ├─► 009 ─┤
                   │                          └─► 010 ─┴─► 011 ──► 012
                   └─────────────────────────────► 015 ──► 016 ──► 017
                                                                 │
                                    018 ──► 019 ──► 020 ─────────┴──► 021 ──► 022
```

**`Tasks/001` and `Tasks/002` are the only unconditional starts.** Everything else has a predecessor,
and the longest chain runs through the shell rather than through the interesting feature.

## Parallelisable once `002` lands

`003` · `004` · `005` · `013` — four independent streams. `004` and `005` are the usual pair: one is
pure data, the other pure parsing, and neither blocks the other.