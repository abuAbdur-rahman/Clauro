# Task 009 — Question tool

**Phase** 2 · **Depends** `007` · **Decisions** D40, D41, D42, D43, D101, D118
**Contracts** §2, §3

**Status: answered end to end 2026-10-09 (D118).** The turn now pauses at a
sole valid question (`TurnEnd::AwaitingAnswer`), the card persists as a
`question_card` row with no result yet, `answer_question` validates through
`resolve_answer` and persists the answer as the call's one `tool_result`,
and the driver resumes the turn — `crates/clauro-loop/tests/question.rs`
(6 tests, all failed first), `tests/seam.rs` card mapping + resolved join
(3 tests), `TranscriptView.test.tsx` answerable card (7 tests),
`ChatView.test.tsx` answer-through-resume (2 tests), and the
`question_answer` Tauri command with auto-resume. The loop↔gate wiring gap
described below predates that fix (gate reset + `gate_note` now live in
`run.rs`); the refusal tests cover the integrated path.
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
- [x] Answer is an ordinary `tool_result` in the append-only log — DONE 2026-10-09
      (D118). `TurnLoop::answer_question` (`crates/clauro-loop/src/run.rs`) validates through
      `resolve_answer` and inserts the call's one result row + block; a second answer finds
      the sibling and fails `AlreadyAnswered`, so I1 pairs exactly once.
      `crates/clauro-loop/tests/question.rs`: pause, persist-once, double-answer refusal,
      unknown/invalid refusal, refused-never-pause, answered-continues-to-end-turn — all six
      failed first. `resolve_answer` (`src/question.rs:105-134`) finally has its production
      caller.
- [ ] Card survives compaction unchanged — **PARTIAL, and untestable today.** The structural argument
      is sound: compaction persists as an ordinary block (`crates/clauro-loop/src/run.rs:477-481`)
      and `tool_result` re-sends as a normal content block with no special case (`:737-741`). **But
      compaction is not implemented** — `compact` is filtered out of every request
      (`run.rs:597`) and no handler is bound, so there is no `/compact` path to survive. Claimed by
      design, observed by nothing
- [x] Secret-shaped prompts refused — `src/question.rs:154-156`;
      `tests/question.rs:98-121` asserts secret, malformed and cap refusals return the **identical**
      string, so the refusal is silent to the model by construction (`D43`)
- [x] Renders inline; scroll position preserved — DONE 2026-10-09.
      `QuestionCard` (`src/features/transcript/TranscriptView.tsx`): options as buttons, skip
      always offered even when the stored options omit it, free-text input only when the card
      allows it, resolved state shows the choice, failures stay field-level and the card stays
      usable. The transcript lives in its own scroller (`ChatView`), so answering never moves
      scroll position. `TranscriptView.test.tsx` (7 card tests) + `ChatView.test.tsx` answer
      integration (2 tests).
