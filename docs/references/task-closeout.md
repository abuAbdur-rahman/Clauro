# Closing a task — the docs move in the same commit

**Ref: `AGENTS.md` §7a.** Added to `AGENTS.md` 2026-10-05; split into this file 2026-10-06.

A task is not finished when its code lands. It is finished when someone can read `Tasks/NNN-slug.md`
and learn what was actually built. This section exists because nine task files drifted: `Tasks/003`
recorded its verification, and `001`–`002`, `004`–`009` and `023` all sat with every acceptance box
still open while nine commits of work sat in the tree.

**Run this before you say a task is done, in the same commit as the code.**

1. **Tick each acceptance criterion, with its evidence.** `[x]` plus a `path:line` citation naming the
   test that discharges it. `Tasks/003` is the model — every box names its test. **A tick with no
   citation is a claim, not a record.**
2. **Do not tick what was not verified.** Leave the box open and say why inline:
   - **UI-only** → `not verified: no frontend yet`. Never infer it from backend work.
   - **Platform** → `NOT RUN ON THIS HOST`, per
     [`windows-development.md`](windows-development.md) (§8a). This is the Linux half of `Tasks/001`.
   - **Partial** → say what exists and name precisely what is missing.
3. **Add a `**Status:**` paragraph** at the top of the task file: what was verified, on what host, on
   what date, with test counts. `Tasks/003` and `Tasks/004` show the shape.
4. **Update the state column in `PHASES.md`** to ✅, ◐ or ⬜. `PHASES.md` §Progress defines the three
   states and says plainly that they are not interchangeable.
5. **Correct every claim the code contradicts, in the same change.**
   [`dependency-policy.md`](dependency-policy.md) (§5a) already makes a false written claim a bug;
   closing a task is when you find them. Five were found this way — see `PHASES.md` §Progress for
   what each one got wrong.

**The rule that catches the rest: a green test suite is not evidence that a task is done.** Prove it
by checking what is *unreachable*. On 2026-10-05 four components had full test coverage and **no
caller outside their own tests** — `resolve()`, `ApprovalQueue`, `QuestionGate`'s `note_call`/`reset`,
and `resolve_answer`. All four passed. None of them worked. Before ticking a criterion, confirm the
thing is **wired into whatever uses it**, not merely implemented:

```
rg -n 'resolve\(\)|ApprovalQueue|note_call|bound_output' crates -g '*.rs'
```

> **Corrected 2026-10-06.** That claim had gone stale and is the reason this paragraph now carries a
> date. Three of the four are now wired from `clauro-loop/src/run.rs` — `resolve()` at `run.rs:436`,
> `ApprovalQueue` via `approvals_for` at `run.rs:155`, `note_call` at `run.rs:167` and `reset` at
> `run.rs:389`. **`resolve_answer` is still test-only** (`question.rs:105`, called only from
> `tests/question.rs`), so it remains the live example of this trap. Re-run the `rg` above before
> trusting any of this; the sentence is a dated observation, not a standing fact.

A symbol appearing only in its own file and its own test is not done. Say so in the task file.

**Two traps this repo has already hit.** Check both by hand at close-out:

- **A test that passes without testing its name.** `tests/prompt.rs:47-55` calls `frozen_hash` twice
  with *identical arguments*. `tests/materialize.rs:139-153` asserts a pure function is deterministic
  where the criterion demanded three rejected mutation attempts. Read the assertion, not the name.
- **Structural proof is not observed proof, and must be labelled.** `Tasks/008`'s "deleting a chat
  leaves its memories" holds because the store has no `delete_thread` at all — unbreakable by
  construction, never exercised. Weaker than the criterion implies, and the file now says so.