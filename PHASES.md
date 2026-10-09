# Clauro — PHASES.md

**Eight phases, twenty-eight tasks.** Each phase lists its tasks, its gate, and what it unblocks.
Sequencing rationale is in `PLAN.md` §4.

Every task is test-first and contract-anchored (`AGENTS.md` §6). A task's file names the failing
test that must exist before implementation.

---

## Progress

**Read this before trusting a `✅`.** A tick means a criterion was verified against real code on
this host, with the evidence cited in the task file. Three states are used, and they are not
interchangeable:

| | Meaning |
|---|---|
| ✅ | Verified on this host, evidence cited. |
| ◐ | Partially done. The task file says exactly what is missing and why. |
| ⬜ | Not done. **UI-only criteria say so explicitly** — `AGENTS.md` §8a forbids filling a blank on inference, and no frontend component exists yet for them. |

**Where the project actually is, 2026-10-05.** Phases 0 and 1 are done in substance. Phase 2 has its
two structural pieces — `007` and `023`, the registry and the loop — and the `memory` handler. What
is missing is the wiring between them, and it is worth being blunt about the shape of it:

- **The loop now consults the registry components at dispatch** (`run.rs`
  dispatches through `resolve()`, holds ask-effects in `ApprovalQueue`,
  tells `QuestionGate` about every non-question call with per-message reset,
  refuses mixed questions by lookahead, and bounds `Ok` previews via
  `bound_output`). Still uncalled: `resolve_answer` (answer persistence needs
  the UI card), and no host drives a turn. `D26` holds twice over — denied
  tools are absent from the request *and* refused if emitted.
- **`src-tauri` registers seven commands and none reaches the loop.** `clauro-loop` is not a
  dependency of the shell crate. Nothing drives a turn from the UI yet.
- **Three silent `let _ =` drops** were on the exact paths `D65`/`D68` guarantee
  (`run.rs:493,716,732`; `PHASES.md` previously cited the stale `290,513,529` — corrected
  in the same change that fixed them). **Fixed by `Tasks/028` (O1):** `insert_tool_block`,
  `insert_notice` and the `cancel_turn` call now return `LoopError::Store` instead of
  vanishing. A failed write fails the turn loudly; nothing on these paths is silent.
- **Six criteria are blocked on a frontend that does not exist** (three in `006`, two in `008`, one
  in `009`, plus `023`'s queue chips). They are not failures; they are unstarted.

**Two defects found in infrastructure that is otherwise green.** `.github/workflows/ci.yml:134` runs
`cargo test` **without `--locked`**, so Cargo lock drift silently updates instead of failing — while
`release.yml:61` says in a comment that "`--locked` is not optional in CI". And the two floor jobs
are not yet floors: `ci.yml:119-122` is a `Write-Host` stub that pins nothing, and `linux floor` is
byte-identical to `linux primary`. `D50` calls a floor failure a release blocker; the floors behind
that guarantee need building. Both are one-line fixes and belong to `Tasks/021`.

**Document corrections made 2026-10-05.** Five false claims were found and corrected in the task
files rather than left standing (`AGENTS.md` §5a): `Tasks/004` said "Eleven tables" when the schema
has twelve (`ARCHITECTURE.md` §4 carried the same error — both corrected); `Tasks/007` named a
`settle()` function that does not exist; `Tasks/007` said "most recent rule wins" for a `resolve()`
where recency is unobservable and precedence deliberately overrides it; `Tasks/007`'s `D94`
append-only test now persists the emitted message through a store round-trip
(`crates/clauro-tools/tests/materialize.rs:change_messages_persist_append_only`) —
move/reword/delete remain API-less by the 004 scan test; and `Tasks/006` claims transcript fixtures exist when the repo's only fixtures
are SSE.

One derived-doc bug is **fixed** rather than just recorded: `CONTRACTS.md` §1's mutable-column list
omitted `account_setting.*`, which is why `Tasks/004`'s enforcement test had to widen its allowlist
and explain why in a comment. The contract now lists it, and a duplicated `thread.memory_off` entry
is gone. `Tasks/004` is the only task in Phases 0–2 whose criteria are all discharged.

---

## Phase 0 — Ground truth

**Purpose:** learn the one thing we cannot research, and stand up a build that can be tested without
a display.

| Task | State | Contract | D-refs |
|---|---|---|---|
| `Tasks/001-dual-engine-sandbox-spike.md` | ◐ Windows verified · **Linux not run** | — (produces a verdict, not code) | D2, D6, D45, D77 |
| `Tasks/002-workspace-skeleton-and-ci.md` | ✅ | — | D50 |
| `Tasks/003-keyring-and-model-catalogue.md` | ✅ verified 2026-10-04, Windows + Linux CI; providers addendum 2026-10-07 (D116/D117) | `ProviderAdapter.limits` + §1 (`provider`, `provider_model`) | D19, D23, D49, D50, D53, D76, D116, D117 |

**Gate:** `001` verdict written and committed. `cargo test` and `vitest` green headless on the
Windows CI jobs. **Linux jobs parked 2026-10-06 (D114), owned by Phase 7 (D115)** — see the Phase 7 gate.

**Gate status:** ✅ closed Windows-only 2026-10-09 (D115). `002` and `003` are complete;
`001`'s Windows verdict is committed (`docs/spikes/sandbox-verdict.md`). The Linux column —
the WebKitGTK app, `event.origin`/`event.source` capture, both Linux jobs — is owned by
Phase 7 and gates nothing here: an unrun floor blocks nothing (D50), and Phases 0–6 close
Windows-only by decision, not by omission. (`event.origin`/`event.source` capture on Windows
itself remains open under `Tasks/014` — that is Phase 3 work, not this gate.)

> **The two floor jobs are labels, not floors yet.** `ci.yml:119-122` is a `Write-Host` stub that pins
> no runtime, and `linux floor` is byte-identical to `linux primary`. The labels are there; `D50`'s
> guarantee behind them is not. Plus `ci.yml:134` omits `--locked`, so Cargo lock drift does not fail
> the build. Both belong to `Tasks/021`.

**Unblocks:** everything. `Tasks/013` waits on the `001` verdict; everything else waits on `002`.

> **`Tasks/001` is the highest-leverage two days in the project.** It answers a question no document
> answers, and it gates a release decision (`D45`). Run it first, on purpose, while the answer is
> still cheap.

---

## Phase 1 — Shell

**Purpose:** a real streaming conversation, on both providers, with a cancel that loses nothing.

| Task | State | Contract | D-refs |
|---|---|---|---|
| `Tasks/004-sqlite-schema-and-append-only.md` | ✅ 9/9 | §1 | D7, D8, D19, D32, D34, D47, D52, D55, D57, D63, D70, D79 |
| `Tasks/005-sse-transport-and-anthropic-adapter.md` | ✅ 8/8 — retry policy has callers (`stream_step`, `LiveExchange`); OpenAI `Ignored`→notice wired; live Gemma 4 smoke shapes recorded; request translator + thought-marker parse landed 2026-10-09 (D119) | §5 | D20, D21, D24, D48, D56, D69, D70, D71, D73, D75, D80, D81, D119 |
| `Tasks/006-transcript-thinking-and-cancel.md` | ✅ renderer + streaming + purify + I1/I3 corpus + gap surfacing, all green 2026-10-09; live keyed turn still human-gated | §2, §3 | D18, D19, D54, D61, D65, D68, D72, D76, D100 |

**Gate:** a streaming turn renders on both adapters; stop mid-turn keeps completed work and closes
every dispatched call; reasoning is one collapsible region for both providers.

**Gate status:** ◐ **substantially met 2026-10-07, one live proof outstanding.** Cancel semantics
are fully paid for — `D65` and `D68` are asserted directly (`Tasks/006`,
`tests/transcript.rs:165-227`) — and `D57`'s `summary_*` separation is structural. The renderer
exists (`src/features/transcript/TranscriptView.tsx`), `Exchange::step` streams, and a host now
drives turns end to end: `turn_start` → dedicated thread → `LiveExchange` → `clauro://turn-event`
→ `ChatView` streaming row → `clauro://turn-done` → `transcript_read`. Since 2026-10-07 the
picker is gated on configured providers (D116): per-provider keys in the keyring, per-provider
`/models` with a 3-day TTL, models.dev as lazy limits-enrichment only — boot downloads nothing.
What keeps the gate from ✅: no turn has run against the live API on this host (no key is stored
here, and no test may need one by rule), and the second adapter's live path is precisely refused
(`UnsupportedProvider`) until the Anthropic→chat-completions request translator lands — the loop
builds Anthropic-shaped bodies, so sending one at a compat endpoint would be a silent 400. The
gate's remaining work is a live-key run plus the translator, not more investigation. **2026-10-07
update:** the socket-level half is now proven for the second adapter by a direct live smoke
(Google Gemini key, `models/gemma-4-26b-a4b-it`): 62 models listed, one text turn completed,
streaming `data:` chunks plus `[DONE]` observed, and the in-band `<thought>` reasoning marker
(`extra_content.google.thought`) recorded in `Tasks/005` for the translator. **2026-10-09
update:** the transcript invariants are corpus-proven (I1/I3 over
`tests/fixtures/transcripts/`, write-time `GenerationRegression` refusal) and thinking gaps are
withheld from requests with one deduplicated notice. **2026-10-09 update (translator, D119):**
the second adapter's live path is built — `openai_request::translate_request` maps the loop's
Anthropic body to chat-completions (Anthropic-only controls dropped, never approximated),
`turn_start`/`question_answer` route from the provider row (compat rows post to
`{base}/chat/completions` with bearer auth; a row with no endpoint URL stays typed-refused),
`assemble_messages` now sends `tool_result` in the following user message — the shape both APIs
require and a latent 400 no test had ever exercised — and Gemini's in-band thought marker parses
response-side from a fixture (`tests/fixtures/openai_thought_marker.sse`). What remains for this
gate is the in-app turn with a stored key (human-gated: no test may use a key by rule).

**Unblocks:** Phase 2 (the loop needs a surface to run against), Phase 4 (the meter needs a real
transcript to measure).

---

## Phase 2 — Tool loop

**Purpose:** the model can call tools, and every failure arrives as a result rather than a crash.

| Task | State | Contract | D-refs |
|---|---|---|---|
| `Tasks/007-tool-registry-and-permissions.md` | ✅ dispatch consults permissions; `resolve_answer` called by answer path | §3 | D19, D26, D27, D39, D51, D55 |
| `Tasks/023-turn-loop-and-system-prompt.md` | ✅ loop enforces permissions/approval/gate/bounding; host drives turns and drains the queue | §2, §3 | D7, D11, D19, D27, D33, D39, D51, D55, D65, D67, D68, D76, D82, D85, D98, D105 |
| `Tasks/008-memory-tool.md` | ✅ backend 8/10; two UI criteria unstarted | §1, §3 | D7, D8, D9, D10, D11, D35, D43, D51 |
| `Tasks/009-question-tool.md` | ✅ pause + answer + resume answered end to end (D118); question card answerable inline | §2, §3 | D40, D41, D42, D43, D101, D118 |
| `Tasks/010-fs-tool.md` | ◐ backend 11/11; ingest/serve/session-dirs uncalled (018/shell later) | §3 | D31, D32, D33, D34, D39, D44, D47, D52, D79, D109 |
| `Tasks/011-web-search-and-fetch.md` | ◐ backend 9/9; live HTTP untested by rule, DDG shape assumed | §3 | D39, D48, D56 |

**Gate:** the turn loop runs to `end_turn`; the five model-callable tools built so far (`memory`,
`question`, `fs`, `web-search`, `web-fetch`) are callable; `compact` is absent from the request
schema; no handler throws. `artifact` and `bash` arrive in Phase 3, so **two of the eight tools are
not yet callable at this gate** — that is expected, not a failure.

**Gate status:** ✅ **met 2026-10-09.** Every clause verified on this host: the loop runs to
`end_turn` (`tests/run.rs` asserts `end == EndTurn` across fixtures); all five named tools are
callable through the registry and driven end to end (`e2e_phase2.rs`: memory, fs, web-fetch,
question through real dispatch); `compact` is filtered out of the request schema by construction
(`build_request`); no handler throws (`catch_unwind` → typed `Error`, `tests/registry.rs`). On top
of the gate's letter: permissions consulted at dispatch, approval hold-and-resume, question-gate
per-message windows, mixed-question refusal, output bounding, a host driving turns, queued
follow-ups draining as in-order turns, and questions pausing/answering/resuming (D118). The two
tools outside this gate (`artifact`, `bash`) remain Phase 3's, as expected.

**Read order inside this phase:** `007` → `023` → the handlers. `023` owns the loop that drives every
handler, so a handler written before it has no defined caller.

> **The wiring gap is the whole story of this phase.** Every piece exists and every test is
> green, and yet nothing drives a turn: `src-tauri/Cargo.toml` does not depend on `clauro-loop`,
> and `generate_handler!` (`src-tauri/src/lib.rs:172-181`) registers eight commands that reach the
> store and the keyring but never the loop.
>
> An earlier version of this note claimed `crates/clauro-loop/src/run.rs:263` dispatched tool calls
> **without consulting `resolve()` or `ApprovalQueue`**, and that "grep for both returns zero
> matches". That was false and has been corrected here. The loop does consult permissions
> (`resolve` at `run.rs`), routes ask-mode approval through `ApprovalQueue` with hold-and-resume,
> tells `QuestionGate` about each call with per-message reset, refuses mixed questions by
> lookahead, and bounds output on the way out — `D27` is enforced at dispatch. Since 2026-10-07 a
> host drives turns (`src-tauri/src/turn.rs`, eighteen commands registered). Since 2026-10-09
> questions pause and resume (D118, nineteen commands with `question_answer`). Still open:
> the idle-queue drain.

**Unblocks:** Phase 3 (`fs` proves the workspace tree before `bash` exists; `artifact` needs the
loop), Phase 4 (compaction needs tools to compact around).

---

## Phase 3 — Gated features

**Purpose:** the two things with real blast radius. Both are gated for a reason.

| Task | State | Contract | D-refs | Gate |
|---|---|---|---|---|
| `Tasks/012-bash-tool.md` | ✅ backend 11+5 | §3 | D28, D29, D30, D46, D66, D67 | D19, D28, D29, D30, D46, D55, D66, D67 |
| `Tasks/013-artifact-drawer.md` | ◐ tool + drawer states green; webview proofs need 021 | §1, §2 | D1, D2, D3, D45, D63, D77 | D1, D2, D3, D45, D63, D77 |
| `Tasks/014-artifact-compile-and-channel.md` | ◐ compile/channel/CSP green; webview + Tailwind CSS need 021 / 022 | §3 | D4, D5, D6, D12, D110, D111 | D2, D4, D5, D6, D12, D78, D102 |
| `Tasks/028-phase3-gate-e2e-and-persist-hardening.md` | ✅ e2e both halves green; silent drops now loud; webview items stay 021 | §1, §2, §3 | D65, D68, D113 | D2, D4, D6, D27 |

**Gate:** artifacts render live and the iframe has no reachable path to app internals; a denied
network request from inside an artifact fails; `bash` runs only after approval.

**Gate status: ◐ partially met, and the reason is the platform, not the work.** `bash` is fully paid
for: approval is a typed state machine with resume and a `Rejection`, and the runner's group kill is
asserted against a live process tree (`Tasks/012`, `crates/clauro-fs/tests/runner.rs`). The artifact
half is verified as far as a headless host allows — the policy is assembled in Rust with every `D3`
directive asserted, the handshake validates origin *and* source on both sides, the port carries a
closed allowlist, SVG is sanitised, in-frame navigation is contained and logged, and a compiled JSX
artifact mounts and responds to a click (`Tasks/014`, 70 tests).

What cannot be met yet, and why, in the order it blocks:

1. **"No reachable path to app internals"** and **"a denied network request fails"** are claims
   about a running engine. `Tasks/001` proved the same properties in a throwaway probe app on
   WebView2; the *product* frame is unobserved, because `tauri-driver` lands in `021`. Both stay open.
2. **"Artifacts render live"** in the product: proven end to end across the seam by `Tasks/028`
   — the Rust half drives `artifact` through the real loop into versioned rows + paired results
   (`e2e_phase3.rs`), the frontend half drives a tool result through the real store actions and
   the real `prepareArtifact` into a live render (`phase3.e2e.test.tsx`). What remains is the
   last inch: no production code maps a live tool result onto the drawer, because no host drives
   turns yet (same gap as Phase 2). The e2e producer is test-local by decision (**D113**), not by
   accident.
3. Artifacts render **without Tailwind** until `022` vendors the stylesheet (`D111`). The frame's
   stylesheet slot exists and is deliberately empty; the prompt already tells the model to use
   predefined utility classes, so this is visible rather than silent.

**Unblocks:** Phase 5 (the drawer is the visual centrepiece of the shell).

---

## Phase 4 — Context

**Purpose:** the app survives a long conversation, on any provider, without lying about cost.

| Task | State | Contract | D-refs |
|---|---|---|---|
| `Tasks/015-token-meter.md` | ✅ `compute_trigger` + `measure` + `NoProgress` green 2026-10-06 (`clauro-tokens/tests/meter.rs:5`) | §4 | D17, D25, D64, D82 |
| `Tasks/016-client-side-compaction.md` | ✅ balanced boundary + prefix-extension + iterations green 2026-10-06 (`clauro-tokens/tests/compaction.rs:6`, `src/compact.rs`) | §4 | D12, D13, D15, D16, D17, D18, D57, D58, D61, D63, D64, D65, D70 |
| `Tasks/017-anthropic-compaction-paths.md` | ✅ on-demand-first + reject >16384 + swap guard + compact excluded green 2026-10-06 (`clauro-transport/tests/compaction_paths.rs:6`, `tests/builders.rs:3`) | §5 | D14, D16, D21, D22, D69, D70, D74, D75, D81, D95 |

**Gate:** compaction fires on `min(ratio, usable − headroom)`; a summariser that changes nothing
cannot authorise a retry; usage after compaction reads `usage.iterations`, not the zeroed fields; no
`tool_use` is ever split from its result.

**Gate status: ✅ met headless 2026-10-06.** `cargo test` 60 suites ok, `clippy` clean, `fmt` clean,
`vitest` 16/114 pass. Trigger = `max(fixedCost+2048, min(ratio, usable))` (`lib.rs:compute_trigger`);
`NoProgress.authorises_retry()==false`; billing sums + context takes last (`compact.rs:usage_from_iterations`,
`anthropic.rs:usage_wire`); `balanced_boundary` lands only where no open `tool_use` remains.
Two known doc debts, not gate failures: `CONTRACTS.md §4` still states D64 formula (SPEC M1 + D82 win),
and SPEC M5 says threshold-preferred while code follows D95 on-demand-first.

**Unblocks:** nothing structurally — but a v1 without this fails on any long thread.

---

## Phase 5 — Product surface

**Purpose:** the features that make it a *product* rather than a shell.

| Task | State | Contract | D-refs |
|---|---|---|---|
| `Tasks/018-projects-and-memory-ui.md` | ✅ scoping + rail + controls green 2026-10-06 (`features/projects/`, store schema + `set_thread_memory_off` D9) | §1 | D8, D9, D32, D35, D36, D37, D52 |
| `Tasks/019-incognito-export-and-retention.md` | ✅ export builders + delete rows/files + confirm + telemetry audit green 2026-10-06 (`features/retention/`, `clauro-store/tests/retention.rs:3`, `clauro-fs/tests/retention.rs:1`) | §1 | D10, D19, D37, D38, D57, D67 |
| `Tasks/020-themes-hotkey-and-command-palette.md` | ◐ palette + themes + in-app hotkey green (`features/shell/`); global shortcut + single-instance need Tauri plugins (follow-up) | — | D42, D44, D66 |
| `Tasks/024-frontend-feature-layout.md` | ✅ (pre-existing 2026-10-06) | — (structure) | D112 |
| `Tasks/025-vendored-shadcn-ui.md` | ✅ (pre-existing 2026-10-06) | — (structure) | D112 |
| `Tasks/026-chat-ui-batch.md` | ✅ (pre-existing 2026-10-06) | — (structure) | D112 |
| `Tasks/027-composer-shell.md` | ✅ (pre-existing 2026-10-06) | — (structure) | D112 |

**Gate status: ◐ substantially met 2026-10-07.** End-to-end task + delete-every-byte proven at unit/integration level
(store rows zero, real-fs subtree gone, export self-contained HTML/MD + JSON round-trip, confirm names
target); the surfaces are now wired into the shell (`src/app/App.tsx`: home greeting + centered composer,
projects grid, project detail with Instructions/Memory/Context rail, nested rail threads, palette with
search + tabs + recents, `src/app/shell.test.tsx` navigation proof) with all labels our own wording
(**D39**). What remains is visual confirmation in the running app. Telemetry audit: `rg`
zero hits source + manifests.

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

**Parked 2026-10-06 (D114), owned by Phase 7 (D115):** Linux primary + Linux floor are out of
`ci.yml` until after full development — definitions preserved in
`.github/workflows/linux-matrix.yml.disabled`, restore owned by Phase 7 together with the cargo
cache + timeout budget. Until then the enforced gate is the two Windows jobs; `D50` is unchanged
(an unrun floor blocks nothing, a failed one blocks everything).

**A floor failure is a release blocker, not a warning.** The floors are where the sandbox guarantee
gets falsified. **D50.**

---

## Phase 7 — Linux and floors (post-deployment)

**Purpose:** everything Linux-shaped that Phases 0–6 provably don't need on Windows, in one
place with one gate, so no earlier phase stays open for it. Created 2026-10-07 (**D115**);
no new tasks — the work already has numbers, only the phase assignment moves.

| Item | Currently in | Moves here |
|---|---|---|
| `001` Linux column (WebKitGTK verdict, `event.origin`/`event.source` capture) | Phase 0 gate | Phase 7 gate |
| Linux primary + Linux floor CI (parked per `D114`, definitions in `.github/workflows/linux-matrix.yml.disabled`) | Phase 6 gate | Phase 7 gate |
| Linux runtime gate proof (`021`, **D45**) | Phase 6 | Phase 7 |
| Cargo cache + job-timeout budget that make Linux jobs meaningful | `021` | Phase 7 |

**Gate:** the `001` Linux column is filled on real WebKitGTK, both Linux jobs pass, and the
Linux gate fires-or-stays-silent correctly. Until then `SPEC.md` §6.3 reads "both floors" as
the two Windows jobs.

**Unblocks:** nothing — this phase is terminal by design.

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