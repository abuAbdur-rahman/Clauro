# AGENTS.md — Clauro

**Read this before touching the repo.** Everything here is load-bearing. The global personal rules in
`~/.config/opencode/AGENTS.md` still apply and are **not** restated — this file only covers what is
true of *this* codebase.

**Approach: TDD + SDD.** Spec-driven: no code without a task in `Tasks/`. Test-driven: no code without
a failing test first. Both are non-negotiable and the reason this project is tractable.

**What is in here and what is not.** Rules that must hold on **every** change are written out below
and appear nowhere else. Rules that apply only **before a particular kind of work** live in
`docs/references/` and are indexed in §0. A citation like **§8a** resolves through that index, so
existing references in `Tasks/`, `DECISIONS.md`, `eslint.config.js` and elsewhere keep working.

---

## 0. Reference index — the situational rule sets

**Split out of this file 2026-10-06.** Each row is the full text of a rule set; nothing is summarised
away and nothing is duplicated. The headline in the second column is the part worth holding in your
head when the file is not open.

| Ref | Rule set | Read it when |
|---|---|---|
| **§4** | [**Porting and attribution**](docs/references/licensing-and-attribution.md) — three MIT repos may be ported; **LobeHub and Open WebUI never**; no Anthropic wording, ever | Before porting anything from another repo, or naming anything |
| **§5a** | [**Adopt the wheel. Record the reference.**](docs/references/dependency-policy.md) — search before hand-rolling; record name, URL, rejected alternative, maintenance date | Before adding a dependency, or before hand-rolling anything non-trivial |
| **§6** | [**Test-first**](docs/references/testing.md) — a test that has never failed proves nothing; no test may need a live key; fixture-first for the SSE parser | Before writing the first line of a test, and before touching the parser |
| **§7** | [**Adding a feature**](docs/references/feature-workflow.md) — belongs? decided? contracted? tasked? tagged? does it move a security claim? | Before starting any feature |
| **§7a** | [**Closing a task**](docs/references/task-closeout.md) — tick with a `path:line`, label what was not verified, prove it is wired into a caller | Before you say a task is done, in the same commit as the code |
| **§8** | [**What needs a human, not an agent**](docs/references/escalation.md) — six triggers; stop and ask | Whenever any of the six triggers applies |
| **§8a** | [**Development and testing are Windows-only, for now**](docs/references/windows-development.md) — a verdict is Windows-only until labelled otherwise | Before writing the word "verified" beside any measurement |
| **§8b** | [**Windows shell tooling**](docs/references/windows-shell.md) — the PowerShell alias trap, and the never/use table | Before reaching for a shell tool |

---

## 1. The document set — read before you write

| File | What it is | Read it when |
|---|---|---|
| `MISSION.md` | What this is and what it is not | Once, then whenever you are unsure whether a feature belongs |
| `DECISIONS.md` | **D1–D124.** Every non-obvious choice *with its reason* | Before any design work. Cite the D-number in your task. |
| `CONTRACTS.md` | The shapes tests assert against | Before writing any type or any test. **If your type cannot cite a D-number, stop.** |
| `FEATURES.md` | Provenance: CALLED / PORTED / MIRRORED / ORIGINAL + terminology | Before porting anything, or naming anything |
| `SPEC.md` | **Normative v1 scope**: what must exist, each with the task that proves it | Before estimating, scoping, or accepting a feature |
| `DESIGN.md` | Surfaces and behaviour | Before touching UI |
| `ARCHITECTURE.md` | Crate graph, turn loop, the two security boundaries | Before adding a crate or crossing a boundary |
| `TECH_STACK.md` | Versions and the workspace layout | Before adding a dependency |
| `docs/dependencies.md` | **The evidence** behind every dependency choice, with the research date | Before adding a dependency — it may already be done |
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

**The artifact iframe is an opaque origin.** A served document with `sandbox="allow-scripts"` and **no
`allow-same-origin`**. **D2** (transport **D123**, host **D124**). Note precisely why: the document location is a *transport* choice, `sandbox` is the
*security boundary*. The served document would be same-origin with the shell on its own — the opaque origin comes
from the attribute. Adding `allow-same-origin` back silently breaks this **and** breaks the
`event.origin` validation the same rule requires.

**No artifact network egress.** `connect-src 'none'`, `img-src data: blob:`, `form-action 'none'`.
Vendor what artifacts need. Do not add a CDN allowlist. **D3.**

**`freezePrototype` does not help.** It runs as an init script on every Tauri *webview*; an artifact
iframe is not a webview. Do not count it toward artifact hardening. **D77.**

**Tauri gates commands by capability and scope, not by caller origin.** A *working* path from an artifact to
`window.__TAURI_INTERNALS__` means that artifact can run every command the app can — and on Windows the object is
present in the frame regardless (the runtime injects into every frame), so the closure is host-side: a document host
remote to IPC plus zero remote capabilities. Never expose
`invoke` to the frame. Use a `MessageChannel` handshake and validate `event.origin` **and**
`event.source` on every message in both directions. **D6, D2, D124.**

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

## 4. Porting — the one-line version

Full text: [`docs/references/licensing-and-attribution.md`](docs/references/licensing-and-attribution.md).
**OpenCode, DeepSeek Harness and LibreChat may be ported. LobeHub and Open WebUI may not, in any form,
for any reason — behaviour only, in our own words and our own implementation.** Anthropic's wording
is never reusable. Every port carries attribution in the file it lands in.

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
  was rejected.** Read [§5a](docs/references/dependency-policy.md) first — the search-before-hand-rolling
  step and the four things every adopted dependency must record all live there.

---

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