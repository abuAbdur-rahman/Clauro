# Clauro — PLAN.md

**How the build is sequenced and why.** Scope lives in `ROADMAP.md`. Phases and their tasks live in
`PHASES.md` and `Tasks/`. This file explains the *ordering* constraints, because most of them are not
obvious and getting one wrong invalidates work.

---

## 1. The one ordering constraint that matters

```
        ┌─────────────────────────────────────────┐
        │  Tasks/001  DUAL-ENGINE SANDBOX SPIKE    │
        │  Windows WebView2 + Linux WebKitGTK     │
        │  Does the opaque origin hold?           │
        └───────────────┬─────────────────────────┘
                        │
          ┌─────────────┴─────────────┐
          │ YES                       │ NO
          ▼                           ▼
   artifacts ship on both      artifacts DISABLED on
   Linux, D45 never fires      Linux at runtime (D45)
                                Windows still ships them
```

No document anywhere answers whether WebKitGTK holds an opaque origin. It cannot be researched, only
run. **Every artifact task sits behind it**, because a renderer that is unsafe on one engine is a
renderer whose CSP and sandbox flags we would be designing twice.

`Tasks/001` produces a written verdict, not code. If the answer is "no on Linux", the rest of the plan
is unchanged — `D45` already specifies the graceful path, and the cost is one runtime check plus a
notice that tells the user why.

## 2. Why the workspace is split per concern

`CONTRACTS.md` §7 promises tests that run with **no provider, no network, no webview.** That promise
is only payable if the token meter, the tool handlers, and the SSE parser do not import `tauri`.

So: `clauro-core` (types) ← `clauro-store` / `clauro-transport` / `clauro-tokens` / `clauro-tools` /
`clauro-fs` ← `src-tauri` (the only crate that knows Tauri exists). Dependencies point inward. A
handler that imports `tauri` is a handler whose tests need a display server.

## 3. The dependency chain inside v1

Not all of these are obvious, and two of them are the reverse of what you would guess.

```
T002 skeleton ──┬─► T003 keyring + catalogue
                │
                ├─► T004 SQLite schema ──┬─► T006 transcript
                │                        │
                ├─► T005 SSE + Anthropic ┴─► T006
                │
                └─► T007 registry + permissions ──┬─► T023 turn loop ──┬─► T008 memory
                                                   ├─► T009 question
                                                   ├─► T010 fs
                                                   ├─► T011 web tools
                                                   └─► T012 bash
                                                                ▲
                                          T015 token meter ─────┘ needs measured surface
                                    T016 client compaction ┘
                                    T017 Anthropic compaction

T001 spike ──► T013 artifact drawer ──► T014 compile + CSP + channel
```

**Two orderings are counter-intuitive:**

- **The token meter precedes `fs` and `bash` in dependency terms, but not in build order.** `fs` and
  `bash` do not need it; *compaction* needs it. `T015` is therefore scheduled after the tools, not
  before — the meter is easier to write correctly against a real transcript than against a mock one.
- **`T012 bash` is late, and that is a security decision.** Building the runner before anything
  validates the workspace tree means the first thing written against `~/.clauros` is the code with
  the largest blast radius. `T010 fs` proves the tree first.

## 4. The phase gates

A phase is done when **every** task's acceptance criteria pass **and** the phase's own gate holds.

| Phase | Gate |
|---|---|
| **0 — Ground truth** | `Tasks/001` verdict written. Workspace builds and tests headless on all four CI jobs. |
| **1 — Shell** | A real streaming conversation renders, on both providers, with cancel that loses nothing. |
| **2 — Tool loop** | The turn loop runs to `end_turn`; every tool implemented **so far** is callable and every failure arrives as a result. Deliberately not a count — `artifact` and `bash` land in Phase 3, so "all tools" cannot be the Phase-2 gate. |
| **3 — Gated features** | Artifacts render and the iframe cannot reach the app. `bash` runs only after approval. |
| **4 — Context** | Compaction fires on the correct bound, twice, and cannot authorise a retry that changed nothing. |
| **5 — Product surface** | A user can complete a real task start to finish and delete every byte. |
| **6 — Release** | Both **floors** pass, not just the primaries. Packaged installers exist for both platforms. |

**A floor failing is a release blocker, not a warning.** The floors are where the sandbox guarantee
gets falsified. **D50.**

## 5. What can run in parallel

Once `T002` lands, these are independent and can be worked concurrently:

- `T003` keyring + catalogue
- `T004` SQLite schema
- `T005` SSE + Anthropic adapter
- `T013` artifact drawer (gated on `T001`, not on the shell)

`T004` and `T005` are the usual pair to parallelise — one is pure data, the other is pure parsing,
and neither blocks the other.

## 6. What we will not do in v1, and why it is not a deferral

| Deferred | Why it is genuinely later |
|---|---|
| Parallel tool calls, tool retries, budget caps | Need the serial loop to be correct first. `D56` already covers transport-level retry so v1 does not silently have zero retry. |
| Research with named stages | 5+ tool calls over 1–3 minutes. Worth doing once the loop is trustworthy. |
| Structured semantic index after compaction | Only LibreChat does this; no second implementation to validate the schema against. |
| `attach` — copy a directory in, sync back | `fs` may prove too confined without it. Designed, deliberately unbuilt. **D44.** |
| Chat search, RAG | Embeddings. v3. |
| Artifact versions, Preview/Code tabs, download | The render must be trustworthy before we let a user pin history. |

## 7. Definition of done, per task

A task is done when:

1. Every acceptance criterion in its file passes.
2. The test named in its file exists and **was seen failing first**.
3. Every D-number it cites is still accurate.
4. `CONTRACTS.md` has the shape if it needed one.
5. `cargo test` and `vitest` pass headless.
6. Nothing new landed in a mutable table, no `any`, no `console.log`, no `eslint-disable` without a
   reason, no secret on disk.
7. If it ported anything: attributed in-file and tagged in `FEATURES.md`.
8. If it changed a user-visible behaviour: `DESIGN.md` updated in the same commit.

## 8. The risk register, ranked

| Risk | Likelihood | Impact | Mitigation | Where |
|---|---|---|---|---|
| WebKitGTK does not hold an opaque origin | **~40%** | Artifacts off on Linux | `D45` runtime disable, decided in advance | `T001` |
| `compaction` and `context_management` combined on one request | **Certain if unguarded** | Hard 400 | Separate request builders, branch never merge. **D21** | `T017` |
| Usage read from zeroed top-level fields after compaction | **High** | UI reads 0/0, looks like a meter bug | Read `usage.iterations`. Fixture required. **D70** | `T017` |
| OpenAI-compatible dialect varies across providers | **High** | Wrong transcript rendered | Degrade **visibly**, never render a plausible wrong answer. **D48** | `T005`, `T018` |
| Thinking replay fails verification | **Medium** | 400s mid-thread | `signature` required, unbroken run only. **D72** | `T006` |
| Binary budget exceeded | Medium | Release gate | Sucrase ~1 MB is known; measure early | `T002`, `T014` |
| Windows reserved names missed | Low | Path failures, data loss in edge cases | Full set incl. superscripts and extensions. **D79** | `T010` |

## 9. The first two weeks, concretely

1. **`T001`** — two throwaway apps, one per engine, a written verdict. Two days.
2. **`T002`** — workspace, CI matrix, headless `cargo test` green on four jobs. Three days.
3. **`T003`** — keyring round-trip, `models.dev` cached. Two days.
4. **`T004`** — the twelve tables, append-only enforced by a test that asserts no update path exists.
   Four days.
5. **`T005`** — SSE parser with all four fixtures, Anthropic adapter. Five days.

That is a fortnight to a streaming conversation rendering real text from a real key — or to the
earliest possible point where we learn the project is not viable, which is the better outcome.