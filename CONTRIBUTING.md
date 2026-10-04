# Contributing

Thanks for reading. This repository is a **specification first**: the rules
below exist because the project has already been wrong once in each of these
ways.

## Before you write anything

1. **Read [`AGENTS.md`](AGENTS.md).** It is short and it is load-bearing.
2. **Read [`DECISIONS.md`](DECISIONS.md).** If your idea is already decided
   there, you are not proposing a feature — you are contradicting a decision,
   and that takes a **new D-number**.
3. **Check [`CONTRACTS.md`](CONTRACTS.md).** If a test can assert your type,
   the shape belongs in the contracts *before* the code exists.
4. **Claim a task in [`Tasks/`](Tasks/).** No code without one.

## The three rules people push back on

**1. Test first, and watch it fail for the right reason.**
A test that has never failed proves nothing. Writing the test and the
implementation together gives you a description of what you built, not a check
on it. Every task in `Tasks/` names the failing test that must exist first.

**2. No new dependency without a line in `TECH_STACK.md` §6.**
It must say why the obvious alternative was rejected. "It was easier" is not a
reason. This also keeps `clauro-core` dependent on nothing but `serde`.

**3. D-numbers are permanent. Supersede, never renumber.**
To overturn a decision, annotate the old one with a supersession note and add
a new one that cites it. History is the point; a renumbered decision destroys
the record of what we believed and when.

## Code standards

- **No `any`.** `unknown` plus narrowing, or generics. This is not negotiable —
  the tool boundary is where untrusted input arrives.
- **Zod at every boundary.** Tool inputs, SSE frames, anything off the wire,
  anything from disk. A handler receives `unknown` and produces a validated
  type or a typed error.
- **Nothing throws across the tool boundary.** Every handler returns a
  `ToolOutcome`. A missing file is `error`, a cancelled call is `aborted`, a
  declined command is `rejected`, and **a non-zero exit code is `ok` with
  output attached** (**D55**).
- **No `console.log`** in committed code.
- **Every `catch`** logs, rethrows, or returns a typed error. Silent swallow is
  a defect.
- **No `eslint-disable` or `#[allow]`** without an inline comment saying why.
- **No secrets** in source, config, or SQLite. The keyring crate only. CI
  enforces `grep -ri 'api[_-]?key\s*='` finding nothing.

## Fixture-first for the parser

Four inputs break a hand-rolled SSE parser, and three of them fail silently:

1. Omitted thinking
2. A compaction response
3. A dropped block
4. An unknown event

Fixtures are synthetic and live in
`crates/clauro-transport/tests/fixtures/`. **No test requires a live API key** —
a test that needs a key is a test that silently stops running.

## Workflow

```
git switch dev
git switch -c feat/artifact-compaction-path
# write the failing test, watch it fail
# write the minimum that makes it pass
# refactor with the test green
```

| | |
|---|---|
| Branches | `main` and `dev` are protected. Work on a branch, open a PR. |
| Commits | Conventional Commits: `type(scope): description` |
| Push | Never force-push. |
| Stage | `git add .` — never selective staging. |
| CI | `scripts/check-docs.py`, the platform matrix, Trivy, and a no-secrets gate must all be green. |
| Releases | Cut by pushing a tag. |

## Changing a security claim

Some changes are not yours to make alone. If your change touches a security
claim, it updates `MISSION.md` §5 **and** `DESIGN.md` §3 in the same commit —
those are user-facing promises.

Likewise, these need a human: dropping a platform, anything that pushes the
binary past ~25 MB, taking anything from an observation-only source, and
renaming a decision.

## Porting and attribution

Behaviour may be borrowed from a permitted MIT project. **Wording may not.**
Every port carries attribution in the file it lands in, and `FEATURES.md`
tracks which is which. If you cannot say which category a change is, it is not
ready to merge.