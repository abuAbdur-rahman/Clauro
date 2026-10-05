# Task 023 — Turn loop and system prompt

**Phase** 2 · **Depends** `006`, `007` · **Blocks** every tool task · **Decisions** D7, D11, D19, D27, D39, D55, D65, D67, D68, D76, D85, D98, D105
**Contracts** §2, §3

**Status: the loop itself is complete and verified 2026-10-05. `cargo test -p clauro-loop` 21/21 on
this host (run 10, prompt 6, queue 5).**

The core claims hold, and several hold by construction rather than by luck. Serial dispatch is
structural: `run.rs:258-277` is a sequential `for` with one `persist_result` per call before the
next, and `tests/run.rs:233-269` asserts result order with zero unpaired `tool_use`. Cancel is
provably correct — `tests/run.rs:271-334` asserts `call-a: Ok` **and** `call-b: Aborted` with zero
orphans, which is `D65` exactly. And the prompt hash is enforced on **every** turn at
`run.rs:208-213`, not merely tested once.

**Three things this file claims that the code does not deliver.**

1. **`D27` is enforced at the loop since the wiring change.** `Ok` previews go
   through `bound_output` at dispatch (`run.rs:dispatch_bounded`) and rows carry
   both paths. The original gap (verbatim preview stored at `run.rs:551-584`)
   is closed.
2. **`D76`'s variation is not expressible through this API.** `run.rs:619` hardcodes
   `tool_choice: {"type":"auto"}`, and `PreparedThread` (`run.rs:51-59`) has no `tool_choice` or
   effort field — only `thinking_budget` and `max_tokens`. The hash-stability half is real, but the
   "these vary per turn" half is not yet reachable through the loop's own types.
3. **Store errors are silently dropped on the paths `D65`/`D68` depend on.** `let _ =
   store.cancel_turn(...)` at `run.rs:290`, and `let _ = store.insert_block(...)` at `:513` and
   `:529`. A failed `tool_result` write would vanish without a trace, which contradicts
   `AGENTS.md` §5 and undercuts the "every dispatched call gets a result" guarantee this task exists
   to establish. **This is the one defect here that could actually lose data**, and it is worth
   fixing before anything else in this phase.

**Two tests pass without proving what their names claim.** `tests/prompt.rs:47-55` calls
`frozen_hash("sys", &["fs"])` twice with identical arguments — it varies nothing, so the effort
criterion holds by signature (`prompt.rs:54` has no parameter through which effort could enter)
rather than by test. And "no prompt string matches reference wording" is a **drift guard, not a
`D39` check**: `tests/prompt.rs:77-114` pins our prompt to hash `33508ece49863540`, which freezes
*our* text and cannot detect that our text equals a reference's. No such check can exist here — the
references are not vendored (`AGENTS.md` §4). The prompt is plainly ours; see the memory-protocol
criterion below.

**Nothing drives the queue.** "Queued follow-ups dispatch once idle" is a **host obligation**: the
loop exposes `drain_next` (`queue.rs:76-78`) and the tests drain by hand and call `run_turn` again.
No driver observes idleness and starts the next turn. `src-tauri` registers seven commands and
**none reaches the loop** — `clauro-loop` is not even a dependency of the shell crate.

> Added by audit 4 finding 6. The loop that drives the registry, and the prompt every tool depends
> on, had no owner. **Read this before `008`–`014`** — those tasks each implement a handler, and the
> loop is what calls them.

## Failing tests first

- A fixture that emits two sequential `tool_use` blocks runs to `end_turn`, dispatching both, in order
- Two `tool_use` blocks in **one** assistant message are dispatched **serially**, and the second
  result appears after the first — v1 has no parallel calls
- The user stops mid-loop: **every** dispatched call gets a result, including the cancelled one (`D65`)
- A turn that stops mid-call keeps its completed work and the partial assistant turn (`D68`)
- `thread.system_frozen` hash is identical across every turn in a thread
- The hash **changes** when the tool list changes — which is why enabling `bash` opens a fresh
  thread (`D19`, `D67`)
- Thinking effort, `max_tokens` and `tool_choice` vary **without** changing the prompt hash (`D76`)
- A handler that throws is caught and becomes a typed error result; the loop continues (`D55`)
- A transport failure terminates the loop with a typed error in the transcript, not a hung turn
- A user message sent mid-turn lands in the per-thread queue and dispatches in order when the loop goes idle (`D98`)
- The queue drains as in-order turns, never merged into one prompt (`D105`)
- Queue chips remove, edit, or send-now; send-now stops generation without draining, then sends that item (`D105`)
- Stop mid-turn with a non-empty queue offers drain-or-discard; discard drops only unsent input, never completed work (`D98`, `D68`)
- **No system-prompt string matches wording from any reference implementation** (`D39`)
- A prompt that mentions `/memories` says what Clauro wants said, in Clauro's words (`D7`, `D11`)

## Do

**The loop.** Stream the response. On a `tool_use` block, dispatch through the registry
(`Tasks/007`), append the result, re-send. Repeat until the assistant returns no `tool_use`, or the
user stops. Serial dispatch only — parallel calls, retry caps and budgets are v2's general tool loop
and are the one thing v1 omits.

*(Corrected 2026-10-05: "bound the output on the way out (`D27`)" has been removed as a claim of
delivered behaviour. `run.rs:551-584` stores `preview` verbatim and `bound_output` has no caller
outside its own test. `D27` is still binding on this code — it is simply not enforced here yet.)*

Nothing crosses the boundary as an exception (`D55`). A handler that cannot proceed returns
`{status:'error', message}`, the model sees it and decides what to do next. A non-zero exit from
`bash` is `ok` with output attached, not an error.

**The system prompt.** Assembled once at the thread's first turn, hashed into
`thread.system_frozen`, never rebuilt (`D19`). It carries the tool inventory, the `fs` preconditions
(read-before-edit is enforced by host state, not by this sentence — `D33`), the output-bounding
behaviour, and **our own** memory protocol instruction.

**Two things this prompt must not contain.** Anything that varies per turn — thinking effort,
`max_tokens`, `tool_choice`, `metadata` — belongs in request parameters, not prompt text (`D76`).
And **no first-party wording, including documentation quotes** (`D39`). We write the memory protocol
ourselves and convey the same intent; that is a deliberate trade to get one memory code path
instead of two (`D51`, `D7`).

**Stop conditions.** `end_turn` · the user stopping · transport failure. **No budget cap in v1** —
there is no general loop to bound, and the context trigger (`D82`) is the real ceiling.

## Acceptance criteria

- [x] A two-`tool_use` fixture runs to `end_turn` with both dispatched, in order — `src/run.rs:235-309`;
      `tests/run.rs:191-231` asserts `end == EndTurn`, `dispatched == [call-a, call-b]`, handler order
      `[fs, memory]`, and two request bodies
- [x] Multiple blocks in one assistant message dispatch serially — `run.rs:258-277` is a sequential
      `for`, one `persist_result` per call before the next, sorted by block index at `:435`;
      `tests/run.rs:233-269` asserts result order with zero unpaired `tool_use`. Serial by
      construction, not incidentally
- [x] Stop mid-loop closes every dispatched call, cancelled included (`D65`) — `run.rs:259-305` halts
      open calls via `store.cancel_turn` plus a `tool_result` block with `Aborted`;
      `tests/run.rs:271-334` asserts `call-a: Ok` **and** `call-b: Aborted` with zero orphans
- [ ] Queued follow-ups dispatch in order once idle; drain-or-discard offered on stop (`D98`) —
      **split verdict. Offer: MET. Once-idle: PARTIAL.** Drain-or-discard fires exactly when the queue
      is non-empty (`run.rs:156-159,311-313`, `queue.rs:98-105`; `tests/run.rs:523-531`,
      `tests/queue.rs:53-59`), and in-order dispatch is real (`queue.rs:76-78`;
      `tests/run.rs:476-521`). But **nothing observes idleness and starts the next turn** — the tests
      drain by hand and call `run_turn` again. No driver exists. See Status
- [ ] Drain is in-order turns, never merged; chips remove/edit/send-now (`D105`) — **split verdict.
      Backend: MET. Chip rendering: UI-only.** Never-merged is proven — `tests/run.rs:515-520` asserts
      two separate user text rows. All three host operations exist and are tested
      (`run.rs:174-191`, `queue.rs:50-73`; `tests/run.rs:533-545`, `tests/queue.rs:26-51`), and
      `send_now` correctly sets the stop flag (`run.rs:189`). **Rendering the chips does not exist** —
      no transcript, no composer. Not verifiable on this host
- [x] Completed work survives a mid-call stop (`D68`) — `run.rs:280-305` aborts only undispatched
      pendings; `discard_unsent` at `:162-166` touches the queue only; `tests/run.rs:326-333`,
      `tests/queue.rs:61-67`
- [x] `system_frozen` hash stable across turns — `prompt.rs:54-64` hashes text and tool names only,
      with no per-turn input; **enforced every turn** at `run.rs:208-213`;
      `tests/run.rs:411-432` asserts a `PrefixChanged` turn ends the thread. Note the weaker
      `tests/prompt.rs:11-27` only proves the builder is deterministic; the loop-side check is the
      real evidence
- [x] Hash changes when the tool list changes (`D19`, `D67`) — `prompt.rs:54-63` mixes tool names into
      the digest; `tests/prompt.rs:29-45`
- [ ] Effort / `max_tokens` / `tool_choice` vary without changing the hash (`D76`) — **PARTIAL. Holds
      by signature; the test is vacuous and the variation is not yet expressible.** The hash function
      `frozen_hash(system_text, tool_names)` has no parameter through which effort could enter
      (`prompt.rs:54`), and wire-level variation is proven at
      `crates/clauro-transport/src/build.rs:76-82` (`tests/effort_varies.rs:27`). But
      `tests/prompt.rs:47-55` calls it twice with **identical arguments**, varying nothing; and
      `run.rs:619` hardcodes `tool_choice`, which `PreparedThread` (`run.rs:51-59`) does not expose.
      See Status
- [x] A throwing handler becomes a typed error result; the loop continues (`D55`) —
      `crates/clauro-tools/src/registry.rs:251-254` `catch_unwind` → `Error`; `run.rs:263-276` never
      unwraps the outcome; `tests/run.rs:336-371` asserts `end == EndTurn` with status `Error`
- [x] Transport failure ends the loop with a typed error, never a hung turn — `run.rs:241-249` calls
      `insert_notice` and breaks with `TurnEnd::TransportError`; `tests/run.rs:373-409` asserts a
      `notice` block lands. It is a `notice` row with `level:"error"` (`run.rs:528-541`), not a
      `tool_result` — worth being explicit that this is the row type meant
- [x] Zero exceptions cross the tool boundary — `src/registry.rs:240-255`, every exit a `ToolOutcome`;
      `tests/registry.rs:93-127` covers panic, stale epoch, unknown tool, unbound and malformed input,
      all typed. `QuestionGate` uses `.expect(...)` on its mutex (`question.rs:49,59,65`) but runs
      inside the handler closure, so `catch_unwind` still converts it; no escape path found
- [ ] No prompt string matches any reference implementation's wording (`D39`) — **PARTIAL: drift
      guard, not a provenance check.** `tests/prompt.rs:77-114` pins our prompt to hash
      `33508ece49863540`; that freezes *our* text and cannot detect that our text equals a
      reference's. No such check can exist — the references are observation-only and not vendored
      (`AGENTS.md` §4). The length assertion at `tests/prompt.rs:86-90` is near-meaningless as a
      wording guard. The text is plainly original; the criterion describes a check that does not exist
- [x] Memory protocol is Clauro's own text (`D7`, `D11`) — `prompt.rs:37-39` carries our own wording
      ("Memory (/memories). The user may ask you to remember small durable notes, one topic at a
      time…"), pinned at `tests/prompt.rs:111`. It correctly says nothing about secrets beyond a
      one-clause prohibition

## Not in this task

Parallel tool calls · retry caps · budget caps (all v2's general loop, `ROADMAP.md` §v2).
The **registry and permission resolution** live in `Tasks/007` — this task consumes them.