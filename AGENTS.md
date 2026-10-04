# AGENTS.md — Clauro

**Read this before touching the repo.** Everything here is load-bearing. The global personal rules in
`~/.config/opencode/AGENTS.md` still apply and are **not** restated — this file only covers what is
true of *this* codebase.

**Approach: TDD + SDD.** Spec-driven: no code without a task in `Tasks/`. Test-driven: no code without
a failing test first. Both are non-negotiable and the reason this project is tractable.

---

## 1. The document set — read before you write

| File | What it is | Read it when |
|---|---|---|
| `MISSION.md` | What this is and what it is not | Once, then whenever you are unsure whether a feature belongs |
| `DECISIONS.md` | **D1–D95.** Every non-obvious choice *with its reason* | Before any design work. Cite the D-number in your task. |
| `CONTRACTS.md` | The shapes tests assert against | Before writing any type or any test. **If your type cannot cite a D-number, stop.** |
| `FEATURES.md` | Provenance: CALLED / PORTED / MIRRORED / ORIGINAL + terminology | Before porting anything, or naming anything |
| `SPEC.md` | **Normative v1 scope**: what must exist, each with the task that proves it | Before estimating, scoping, or accepting a feature |
| `DESIGN.md` | Surfaces and behaviour | Before touching UI |
| `ARCHITECTURE.md` | Crate graph, turn loop, the two security boundaries | Before adding a crate or crossing a boundary |
| `TECH_STACK.md` | Versions and the workspace layout | Before adding a dependency |
| `PLAN.md` · `ROADMAP.md` · `PHASES.md` · `Tasks/*` | What to build, in order | Before starting anything |

**The authority order is fixed.** `MISSION.md` decides *whether*, `SPEC.md` decides *whether it
exists, fully*, `DECISIONS.md` decides *why*, `CONTRACTS.md` decides *what it looks like*,
`ARCHITECTURE.md` decides *how it fits together*, `DESIGN.md` decides *how it feels*. A later
document never overrides an earlier one without a new D-number. **D87.**

`DECISIONS.md` §3, `ROADMAP.md`, `CONTRACTS.md` §6 and `PHASES.md` are **derived** from
`SPEC.md`. Where any of them disagrees with `SPEC.md`, `SPEC.md` wins and the derived copy is a bug
to fix in the same change.

---

## 2. The seven rules that exist because we got them wrong

**1. Append-only.** `message` and `block` are never updated. A correction is a new row at a higher
`seq`. `seq` gaps are legal — a compaction removes a run. Exactly four tables are mutable:
`thread.title`, `project.name`, `project.instructions`, `memory.body`. **D19.** The prefix guarantee
only holds if history is never rewritten, and the generation counter only means something if the
surface is monotonic. **D63.**

**2. Output is bounded on the way out, never on the way in.** A tool returns a bounded `preview`; the
full text is written to disk and the model gets `previewPath` so it can re-read it. Truncating at
write time loses data permanently. **D27.**

**3. Nothing throws across the tool boundary.** Every handler returns a `ToolOutcome`. A missing file
is `error`, a cancelled call is `aborted`, a declined command is `rejected`, and **a non-zero exit
code is `ok` with output attached.** **D55.**

**4. `system` and `tools` are frozen for the life of a thread.** Changing them mid-thread invalidates
thinking. **D19.** Note what *is* allowed to vary: thinking effort, `max_tokens`, `tool_choice`,
`metadata`, `thinking.display`, `cache_control`. **D76.** Enabling `bash` on a project therefore
**opens a fresh thread**. **D67.**

**5. A denied tool is removed from the request, not filtered from the results.** It cannot be called,
cannot confuse the model through its description, and cannot be socially engineered into being called.
**D26.**

**6. The prompt is advisory. The host is authoritative.** `fs.edit` requires a prior `read` of that
path *this session*, enforced by host state. Every `fs` precondition is a state machine in Rust, not
a sentence in a prompt. **D33.**

**7. Re-send thinking blocks only as an unbroken run.** `signature` must be captured — a persister
stopping at `content_block_stop` replays blocks that fail verification. Removing one thinking block
from the *middle* invalidates every later one. **D72.**

---

## 3. Security rules — non-negotiable, and the reason the product exists

**The artifact iframe is an opaque origin.** `srcdoc` with `sandbox="allow-scripts"` and **no
`allow-same-origin`**. **D2.** Note precisely why: `srcdoc` is a *transport* choice, `sandbox` is the
*security boundary*. `about:srcdoc` inherits the parent origin on its own — the opaque origin comes
from the attribute. Adding `allow-same-origin` back silently breaks this **and** breaks the
`event.origin` validation the same rule requires.

**No artifact network egress.** `connect-src 'none'`, `img-src data: blob:`, `form-action 'none'`.
Vendor what artifacts need. Do not add a CDN allowlist. **D3.**

**`freezePrototype` does not help.** It runs as an init script on every Tauri *webview*; a `srcdoc`
iframe is not a webview. Do not count it toward artifact hardening. **D77.**

**Tauri gates commands by capability and scope, not by caller origin.** Any path from an artifact to
`window.__TAURI_INTERNALS__` means that artifact can run every command the app can. Never expose
`invoke` to the frame. Use a `MessageChannel` handshake and validate `event.origin` **and**
`event.source` on every message in both directions. **D6, D2.**

**Path safety order is load-bearing.** Canonicalise, resolve symlinks and junctions, **then** check
traversal — checking first is bypassable. Windows reserved device names are rejected
case-insensitively **and with any extension**: `NUL.txt` is `NUL`. The set is
`CON PRN AUX NUL COM1–COM9 LPT1–LPT9` plus superscript `COM¹²³` / `LPT¹²³`. **D34, D79.**

**Windows security state is the DACL, not the mode bits.** `chmod` drives only the read-only
attribute and `stat().mode` reports synthetic `0666`. Create the staging directory inside
`dirname(target)` so it inherits the destination DACL — never in `%TEMP%`. Replacement preserves the
target's existing DACL. Do not invent an owner-only policy; it breaks inheritance. **D34.**

**`bash` is off by default, per-project, per-invocation, and persists nothing.** No trust-on-first-use,
no allowlist, no remembered prefix. One host-owned runner: process-group kill, credential scrub on the
child environment, fd0 `/dev/null`, **no `stdin`/`env` on the model-facing tool**, env merge order
`scrub → overrides → env → managed`. **D28, D66, D67, D29, D30.**

**`question` refuses secret-shaped prompts.** The card is durable — it survives compaction and export
— so it is a channel for persisting credentials. Refuse silently to the model; the question fails as
a typed `tool_result`. **D43.**

---

## 4. Porting and attribution — this project borrowed, and honesty about it is a requirement

**Three MIT sources may be ported:** OpenCode (`anomalyco/opencode`, `dev`), DeepSeek Harness
(`deepseek-ai/deepseek-harness`, `master`), LibreChat (`LibreChat-AI/LibreChat`, `main`).

**One repo is observation-only and nothing may be taken from it:** LobeHub. Its licence requires a
commercial agreement for any derivative work and reserves unilateral amendment. Clauro is MIT, so
LobeHub's code, prompts and wording are all off limits. Behaviour may be described as evidence.
**D59, D60.**

**Anthropic's first-party material is proprietary.** Behaviour may be mirrored. **No wording may be
reused** — including documentation quotes. **D39.** If you catch a verbatim quote from their docs in
this repo, that is a bug; paraphrase it and cite the URL.

**Two MIT repos contain proprietary prompt text inside them.** OpenCode's `read` and `edit` prompts
carry first-party wording verbatim; MIT cannot relicense it. Our `fs` prompts are written from
scratch. Behaviour is borrowed, wording is ours.

**Every port carries attribution** in the file it lands in. `FEATURES.md` tracks which is which.
If you cannot say which of the four tags a change is, it is not ready to merge.

---

## 5. Code standards

- **No `any`.** `unknown` plus narrowing, or generics. This is enforced by lint and it is not
  negotiable — the tool boundary is where untrusted input arrives.
- **Zod at every boundary**: tool inputs, SSE frames, anything off the wire, anything from disk.
  A tool handler receives `unknown` and produces a validated type or a typed error.
- **No `console.log`** in committed code. Logs are local files, via the logging crate, at a level
  the user controls.
- **Every `catch`** logs, rethrows, or returns a typed error. Silent swallow is a defect.
- **No `eslint-disable` / `#[allow]`** without an inline comment saying why.
- **No secrets in source, config, or SQLite.** The keyring crate only. `grep -ri 'api[_-]?key\s*='`
  must find nothing.
- Dependencies point inward: `clauro-core` depends on nothing but `serde`. A handler in
  `clauro-tools` may not import `tauri`.
- **No new dependency without a line in `TECH_STACK.md` §6 explaining why the obvious alternative
  was rejected.**

---

## 6. Test-first, and what that means concretely

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

---

## 7. Adding a feature

1. **Does it belong?** Check `MISSION.md` §"What it is not". If it only makes sense inside a coding
   workflow, it does not ship.
2. **A decision exists?** If it is non-obvious, it needs a D-number *before* code. Not after.
3. **A contract exists?** If a test can assert it, `CONTRACTS.md` needs the shape first.
4. **A task exists?** Write `Tasks/NNN-slug.md`. No code without one.
5. **Ported or original?** Tag it. If ported, cite the repo and commit.
6. **Does it change a security claim?** If yes, update `MISSION.md` §"the four claims" and
   `DESIGN.md` §3 in the same commit.

## 8. What needs a human, not an agent

- **Changing a security claim.** `MISSION.md` §5 and `DESIGN.md` §3 are user-facing promises.
- **Disabling a feature on a platform.** `Tasks/001` may conclude that WebKitGTK will not hold an
  opaque origin. That is a release decision and the user is told in the product, not in a changelog.
- **Anything that raises the binary budget past ~25 MB.**
- **Taking anything from LobeHub.** Ever. If it looks like the only way, it is not.
- **Renaming a decision.** D-numbers are permanent. Supersede, never renumber.

## 9. Repo conventions

- **Conventional Commits**, `type(scope): description`. Types: `feat fix refactor perf docs test
  chore build ci style revert`.
- **Never `git add` selectively** — stage everything, review, then commit.
- **Never commit** secrets, `.env`, `node_modules/`, `target/`, or build output. Reports are
  generated artifacts and never enter the repo.
- **Never force-push.**
- **Never `git clone` or merge an unvetted repo.** This project ported from three specific MIT repos;
  adding a fourth is a licensing decision, not a convenience.
- **Windows and Linux floors are release blockers, not warnings.** A failure on the floor CI job
  invalidates the sandbox guarantee on that platform. **D50.**