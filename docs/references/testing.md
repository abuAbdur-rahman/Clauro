# Test-first, and what that means concretely

**Ref: `AGENTS.md` §6.** Split out of `AGENTS.md` on 2026-10-06.

Every task in `Tasks/` names a failing test that must exist before implementation. The discipline that
matters:

```
1. Write the test. Run it. Watch it fail for the right reason.
2. Write the minimum that makes it pass.
3. Refactor with the test green.
```

**A test that has never failed proves nothing.** If you write the test and the implementation
together, the test is a description of what you built, not a check on it. This is how the D54 / D57 /
D64 class of bug reaches shipping — they all looked fine until something that was not considered
rendered as 0/0.

**No test requires a live API key.** That is a design constraint. A test that needs a key is a test
that silently stops running. SSE fixtures are synthetic and live in
`crates/clauro-transport/tests/fixtures/`.

**The seams already exist** — `CONTRACTS.md` §7 lists them. Your test hangs off a contract, not off a
prose description of a decision.

**Fixture-first for the parser.** Omitted thinking, a compaction response, a dropped block, an
unknown event. These are the four a hand-rolled SSE parser gets wrong, and three of them fail
silently.

## Related

Closing a task is where a test gets checked for real — see [`task-closeout.md`](task-closeout.md)
(§7a), including the two traps this repo has already hit: a test that passes without testing its name,
and structural proof passed off as observed proof.