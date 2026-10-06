# Task 007 — Tool registry and permission resolution

**Phase** 2 · **Depends** `006` · **Decisions** D26, D27, D39, D51, D55, D108, D109
**Contracts** §3

**Status: the components are built and well tested, but two of them are inert — nothing calls
`resolve()` or `ApprovalQueue`.** `cargo test -p clauro-tools` 42/42 on this host, including 8
`materialize` tests that cover the whole `D94` availability matrix.

**The gap that matters.** `crates/clauro-loop/src/run.rs:263` dispatches tool calls **without
consulting either** — grep for `resolve`, `ApprovalQueue`, `QuestionGate` and `hold` across
`crates/clauro-loop/src/` returns **zero matches**. So permissions are not enforced at execution
time, and ask-mode approval is never routed. The state machine is real and correctly tested
(`src/approval.rs:66-149`, `tests/approval.rs`), it simply has no consumer. `D26` itself still
holds, because a denied tool *is* absent from the serialised request
(`src/materialize.rs:82`, `crates/clauro-loop/src/run.rs:593-608`) — the guarantee is carried at
materialise time, not at dispatch time. But the enforcement point this task was written to
establish is not wired, and that belongs to whoever lands the loop's host.

**Three claims in this file that the code contradicts.** Corrected here rather than left standing,
per `AGENTS.md` §5a:

1. **`settle()` does not exist.** Line 20 below says "`materialize()` → definitions + `settle()`",
   and `crates/clauro-tools/tests/registry.rs:5` names it too. The actual entry point is
   `Registry::dispatch()` (`src/registry.rs:240`); `grep` finds no `settle` anywhere.
2. **"Most recent rule wins" is unsatisfiable as written.** `resolve()`
   (`src/permission.rs:17-23`) folds each effect to `Some(())`, so recency is unobservable; across
   effects, fail-closed precedence deliberately overrides it. `tests/permission.rs:49-59` uses two
   `Allow`s and passes vacuously — it asserts nothing about recency. What the code actually does is
   documented in its own module header (`src/permission.rs:1-6`): last rule **within its own effect
   class** wins, then `deny > ask > allow`. The criterion should be reworded to match.
3. **The `D94` append-only test does not test append-only.**
   `crates/clauro-tools/tests/materialize.rs:139-153` clones a pure function's output and compares
   equality. It performs **no store round-trip and never attempts move, reword or delete**. The only
   real evidence is `Tasks/004`'s source scan at `crates/clauro-store/tests/append_only.rs:46-70` —
   a different crate and a different test.

Also worth knowing: the wording criterion is a **drift guard, not a `D39` provenance check**.
`tests/descriptions.rs:11-53` pins *our own* eight descriptions. Nothing compares them against any
reference repo, and nothing could — the references are observation-only and not vendored
(`AGENTS.md` §4). The prose is plainly original; the criterion as written is not what is asserted.

## Failing tests first

- A denied tool is **absent from the serialised request**, not filtered from results
- `resolve()` — `deny` beats `allow` regardless of rule order
- `resolve()` — the most recent matching rule wins
- Every handler returns a `ToolOutcome`; **nothing throws**, including on invalid input
- A handler returning 5 MB of output stores all of it and previews a bounded slice
- `previewPath` re-read returns byte-identical content
- A held call walks queued → pending → approved → resumes, draining siblings in order (**D109**)
- A rejected held call becomes a typed `error` result; the loop continues, nothing deleted (**D109**)
- A tool name outside the fixed eight is rejected; no code loads at runtime (**D108**)

## Do

**Registry.** `materialize()` produces definitions; `Registry::dispatch()` (`src/registry.rs:240`) is
the call path. Each registration carries an identity object captured at materialise time; a mismatch
returns `{type:'error', value:'Stale tool call'}`. That directly serves `D19`'s frozen tool list.
*(Corrected 2026-10-05: this previously read "`materialize()` → definitions + `settle()`". No
`settle` exists anywhere in the repo.)*

**Permissions — the part that matters.** A denied tool is **removed from the request entirely**, so
it cannot be called, cannot confuse the model through its description, and cannot be socially
engineered into being called. `D26`.

Split the provenance honestly:
- **PORTED (OpenCode):** `whollyDisabled()` → `registrations.delete(name)`, and `findLast()` — the
  last rule matching a tool **within its own effect class** wins.
- **ORIGINAL:** the three-way `deny → ask → allow` precedence applied across the folded values. This
  exists in **neither** MIT reference. It is ours because the order fails closed: a wrong match still
  lets `deny` win.
- *(Corrected 2026-10-05: this previously read "most recent rule wins", unqualified. Because each
  effect is folded to `Some(())`, recency is unobservable — and across effects the fail-closed
  precedence overrides it deliberately. `src/permission.rs:1-6` always documented the accurate
  version; this line is what had drifted.)*

**Output bounding on the way out.** Full output → `full_path`. Transcript gets a bounded `preview`
plus `previewPath` so the model can re-read. `D27`. Strictly better than truncating at write time,
which loses data permanently.

**All descriptions are ours, written from scratch.** `D39`. Two MIT repos carry first-party prompt
text verbatim inside them; MIT cannot relicense it. Behaviour is borrowed, wording is ours.

**Clauro defines its own `memory` tool** rather than sending Anthropic's `memory_20250818`, so
memory works on every provider. `D51`. We give up the API's auto-injected protocol and write the
equivalent ourselves — one code path, one test surface.

## Acceptance criteria

- [x] Denied tool absent from the request body — `src/materialize.rs:82` filters `state.denied`;
      serialised at `crates/clauro-loop/src/run.rs:593-608`; `tests/materialize.rs:103-121`. Absent
      from the vector, not filtered from results (`D26`)
- [x] `deny` wins over `allow` in every ordering — `src/permission.rs:24-32`; `tests/permission.rs:20-38`
      covers ask→deny, deny→ask, allow→deny. Fail-closed precedence confirmed
- [ ] Most recent rule wins — **PARTIAL, and the criterion is unsatisfiable as written.**
      `src/permission.rs:17-23` folds each effect to `Some(())`, making recency unobservable, and
      precedence deliberately overrides it across effects. `tests/permission.rs:49-59` asserts two
      `Allow`s yield `Allow` — vacuous. **Reword to** "last rule *within its own effect class* wins,
      then `deny > ask > allow`", which is what `src/permission.rs:1-6` documents and what the code
      does. See Status
- [x] Zero throws across the tool boundary, including on malformed input —
      `src/registry.rs:240-255` wraps the handler in `catch_unwind` and returns typed errors for
      stale epoch, unknown tool, unbound call and malformed input; `tests/registry.rs:92,107,125,144`
      covers all four including the panic. Note: no schema validation at the boundary — input arrives
      as raw `serde_json::Value` and each handler validates itself, which is a deviation from the
      Zod-at-every-boundary rule in `AGENTS.md` §5 worth a decision
- [x] Approval walks typed states with resume on approve and typed outcome on reject (**D109**) —
      states at `src/approval.rs:16-21`, transitions at `:66-124`, resume/reject at `:127-149`;
      `tests/approval.rs:12,29,50,69` all pass (declines surface as `rejected` per `CONTRACTS.md` §3,
      which beats D109's loose "error" wording). **Wired since the loop change:** ask-effects hold at
      `crates/clauro-loop/src/run.rs` dispatch, `approve_call` resumes on the next turn
      (`crates/clauro-loop/tests/wiring.rs:ask_holds_then_dispatches_after_approve`).
- [x] No runtime tool loading; the set is fixed at eight (**D108**) — `src/registry.rs:15-24` (`EIGH`),
      `:193` rejects a ninth, `:218` rejects binding an unknown name; `tests/registry.rs:22,40`;
      `tests/no_tauri_dep.rs:29` also passes
- [x] 5 MB output fully stored, preview bounded, re-read identical — `src/bounding.rs:12` (8 KiB
      preview cap), `:56-85`; `tests/bounding.rs:19-42` writes 5 MiB, stores it whole, and re-reads
      byte-identical; char-boundary safety at `tests/bounding.rs:45` (`D27`). **Wired since the loop
      change:** `Ok` previews are bounded at dispatch (`run.rs:dispatch_bounded`) and rows carry
      both paths (`crates/clauro-loop/tests/wiring.rs:big_previews_store_paths_and_stay_bounded`).
- [x] Stale tool call detected — `src/registry.rs:241-245` checks the epoch before any handler
      lookup; `tests/registry.rs:56-90` (`D19`)
- [ ] No description text matches any reference implementation's wording — **PARTIAL: drift guard,
      not a provenance check.** `src/registry.rs:78-149`; `tests/descriptions.rs:11-53` pins our own
      eight strings word-for-word. Nothing scans reference phrasing and nothing could — references
      are not vendored (`AGENTS.md` §4). The text is plainly ours; the criterion describes a check
      that does not exist. See Status

## Tool availability is a first-class output of this task (`D94`)

`materialize()` now takes per-thread permission state as well as project permissions, because on the
Claude API the effective tool set changes **without** editing the `tools` array.

Failing tests first:

- [ ] Every tool is emitted in the first request's `tools` array; unavailable ones carry
      `defer_loading: true`. **Assert no tool is ever added to or removed from that array afterwards.**
      — **PARTIAL.** Eight tools with deferred flags and a freeze assertion are covered at
      `tests/materialize.rs:34-58,61-86,89-100`; `defer_loading` is actually written into the request
      at `crates/clauro-loop/src/run.rs:603-605`. **But the freeze is asserted on the in-memory
      `Vec<MaterializedTool>`, not on a serialised body** — `build_request` is private
      (`run.rs:587`) and no test calls it twice across a permission change. And "every tool" holds
      only modulo `D26`, since denied tools are filtered (`src/materialize.rs:82`)
- [x] Granting `bash` mid-thread produces a `tool_addition` block naming it — **not** a rewritten
      request, and **not** a new thread (`D94`) — `src/materialize.rs:60-62,68-70,139-143`;
      `tests/materialize.rs:60-86` asserts the `role:"system"` wrapper and array equality; beta header
      at `src/materialize.rs:157`, joined at `run.rs:623-628`
- [x] Revoking produces `tool_removal` — `src/materialize.rs:144-148`; `tests/materialize.rs:88-100`
- [ ] A `role: "system"` message carrying a tool change is **append-only**: the test attempts to move,
      reword and delete one, and asserts all three are rejected (`D94` — it joins the prefix). —
      **PARTIAL: the test does not do what the criterion says.** `tests/materialize.rs:139-153` clones
      a pure function's output and compares equality; it performs no store round-trip and never
      attempts move, reword or delete. Real evidence exists but belongs to another crate —
      `crates/clauro-store/tests/append_only.rs:46-70`. See Status
- [x] On the OpenAI-compatible adapter the same scenario instead freezes the array and the thread
      cannot change its tool set. **Both behaviours are asserted**, because they differ on purpose. —
      `src/materialize.rs:93-107`; OpenAI side at `tests/materialize.rs:123-137`, Anthropic side at
      `:34-58`. Deliberate divergence, both halves covered
- [x] A denied tool is absent from the serialised request (`D26`), *not* merely filtered from results —
      same evidence as the first criterion. Duplicate of the main-section item; no separate test
