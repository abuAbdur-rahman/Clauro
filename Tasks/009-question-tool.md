# Task 009 — Question tool

**Phase** 2 · **Depends** `007` · **Decisions** D40, D41, D42, D43, D101
**Contracts** §2, §3

**Status: handler complete and unit-tested, but the turn boundary does not exist. In progress.**
`cargo test -p clauro-tools` 58/58 on this host, 5 of them `tests/question.rs`.

**The gap that makes three criteria PARTIAL rather than MET: the loop never talks to the gate.**
`QuestionGate` has its cap, its `must_refuse` logic and its `note_call` recorder
(`src/question.rs:28-68`, `:160`) — and grep for `QuestionGate` and `note_call` across
`crates/clauro-loop/src/` returns **zero matches**. Only the test calls them
(`tests/question.rs:82`). Two consequences follow, both read from the code rather than observed:

- **After the first question in a thread's lifetime, every later question is refused forever** —
  nothing ever calls `reset()`.
- **`D101`'s mixed-call half is unproven in the integrated path.** The test passes because it calls
  `gate.note_call("fs")` by hand. A `question` beside another call in one real turn would not be
  refused.

**No code path persists an answer.** `resolve_answer` (`src/question.rs:105-134`) is validated and
tested (`tests/question.rs:123-138`), but grep finds no caller outside its own test, and nothing
connects a validated answer to `store.insert_tool_result`. So the claim below that the answer "lands
in the append-only log" is not yet true — the validation half is written, the persistence half is not.
That is why the implementation commit landed but the documentation stayed open.

The secret refusal is the strongest thing here and needs no caveats: secret-shaped, malformed and
cap refusals all return the **identical** string `"question not accepted"`
(`src/question.rs:22`, asserted `tests/question.rs:98-121`), so the refusal is silent to the model by
construction rather than by convention.

## Provenance, stated up front

- **D40 is PORTED** — OpenCode ships `question` in its builtin set.
- **D41, D42, D43 are Clauro-ORIGINAL.** Audit 2 found the per-turn cap and the secret refusal exist
  in **no** reference implementation.

## Failing tests first

- A second `question` call in one assistant turn is refused as a `tool_result`
- A `question` call beside any other tool call in one turn is refused as a `tool_result` (**D101**)
- A secret-shaped prompt is refused, and the refusal is **silent to the model**
- The answer arrives as an ordinary `tool_result` and lands in the append-only log
- The card survives compaction with no special handling
- "Skip / decide for me" is present on every card

## Do

**First-class tool, not prose** (`D40`). Answer returns as an ordinary `tool_result`, which is why it
survives compaction untouched — the same property that makes the memory tool work.

**Inline, never a modal** (`D41`). A modal breaks the stream and throws away scroll position. Inline,
the turn visibly pauses at the point of the question, which is also the honest description of what is
happening.

> **Both MIT references do the opposite.** OpenCode docks to the composer
> (`session-question-dock.tsx`); DeepSeek puts a card in the bottom `min(60vh, 520px)`. **This is a
> deliberate divergence** — the one place we knowingly disagree with every reference we learned from.
> Do not "fix" it toward the references.

**One call per assistant turn, always offering skip** (`D42`). A model with an unlimited question
tool will stall a session and spend tokens on repeated clarification. The cap plus an always-present
escape makes it an affordance rather than an interrogation. A model that ignores the cap and loops is
a bug to degrade from, not one to invite.

**Never carries secrets** (`D43`). The card is durable — it survives compaction *and export*, so it
is a channel for persisting credentials into files that get synced and shared. Refuse silently; the
question fails as a typed `tool_result`.

## Acceptance criteria

- [x] One question per turn, enforced — gate at `src/question.rs`, recorder in the
      handler; the loop resets per assistant message and notes every non-question dispatch
      (`crates/clauro-loop/src/run.rs` gate reset + `gate_note`). `tests/question.rs:63-75` plus
      loop-level mixed coverage below.
- [x] A second or mixed call in the same turn refused as a typed `tool_result` (**D101**) —
      second-call via handler cap; mixed via loop lookahead refusing question pendings upfront
      (`crates/clauro-loop/tests/wiring.rs:mixed_question_call_refused_others_dispatch`).
- [x] Skip always offered — `src/question.rs:25-26` (`SKIP_ID`, `"Skip / decide for me"`), appended
      when absent at `:175-176`; `tests/question.rs:51-61` asserts the card text contains it. Guaranteed
      in the text itself, so a client rendering options generically cannot lose it (`D42`)
- [ ] Answer is an ordinary `tool_result` in the append-only log — **PARTIAL. Validation is done;
      persistence is absent.** `resolve_answer` at `src/question.rs:105-134` →
      `AnswerResolution`, tested `tests/question.rs:123-138`. But no caller exists outside that test
      and nothing reaches `store.insert_tool_result`. See Status
- [ ] Card survives compaction unchanged — **PARTIAL, and untestable today.** The structural argument
      is sound: compaction persists as an ordinary block (`crates/clauro-loop/src/run.rs:477-481`)
      and `tool_result` re-sends as a normal content block with no special case (`:737-741`). **But
      compaction is not implemented** — `compact` is filtered out of every request
      (`run.rs:597`) and no handler is bound, so there is no `/compact` path to survive. Claimed by
      design, observed by nothing
- [x] Secret-shaped prompts refused — `src/question.rs:154-156`;
      `tests/question.rs:98-121` asserts secret, malformed and cap refusals return the **identical**
      string, so the refusal is silent to the model by construction (`D43`)
- [ ] Renders inline; scroll position preserved — **UNMET, UI-only.** No card renderer, no transcript,
      no scroll container anywhere in `src/`. Not verifiable on this host (`AGENTS.md` §8a) across the pause
