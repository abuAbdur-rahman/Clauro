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
| `DECISIONS.md` | **D1–D113.** Every non-obvious choice *with its reason* | Before any design work. Cite the D-number in your task. |
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

**One more repo is observation-only:** Open WebUI, kept locally at `D:\oss\reference\claude`
(relocated 2026-10-04; formerly `D:/oss/open-webui`). Its custom Open WebUI License carries a
branding-preservation clause — removing "Open WebUI" branding over 50 end users without permission
is a material breach — so nothing may be ported: no code, no prompts, no wording, no component or
class names. Behaviour may be mirrored in our own words with our own implementation. **D103.** A
Rust stack does not waive this; reimplementation can still be derivative.

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

## 5a. Adopt the wheel. Record the reference.

**Added 2026-10-04.** The instinct to hand-roll is the expensive one, and it is the one this project
is most likely to indulge because it feels like diligence. It is not. A hand-rolled text diff is a
bug farm with a nice UI.

**Before writing anything non-trivial, search for the library that already does it.** Both
registries: `npm view`, and `crates.io/api/v1/crates/<name>`. This applies to parsing, diffing,
watching a filesystem, and every algorithm someone else debugged for a decade.

**Then vet it, and write down what you found.** A dependency nobody can reconstruct six months from
memory is a dependency nobody dares remove. Every adopted dependency records:

1. **Name, version, licence.** Must be MIT/ISC/Apache-2.0/CC0-compatible with our MIT licence.
2. **The URL** — repo or registry page.
3. **The alternative rejected, and why.** This is the part that matters. Without it the next person
   re-litigates the decision.
4. **The maintenance state as of the date checked.** Last release date, not download count —
   downloads reward abandonment. `eventsource-stream` has 25M downloads and died in 2022.

**Prefer the maintained thing over the popular thing.** Six stars with a release last month beats
six hundred thousand downloads with no release since 2022.

**A false claim in a spec is a bug.** When research invalidates something written down — the way
`reqwest-sse` invalidated "both SSE crates are unmaintained" — correct it in the same change and
keep the correction visible. Do not quietly rewrite history and do not leave the false claim standing.

**Research is not installation.** `TECH_STACK.md` §7.2 and `docs/dependencies.md` §5 list wheels that
were identified and vetted so the owning task does not re-research them. Nothing in those tables is
installed. Each still needs its own task and its own row before it lands.

**Scope discipline.** "We should use a library for this" is a claim to verify, not a licence to add
four. A dependency crossing the artifact sandbox or the tool host is a **security-surface change**,
not a convenience — see §8.

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

## 7a. Closing a task — the docs move in the same commit

**Added 2026-10-05.** A task is not finished when its code lands. It is finished when someone can read
`Tasks/NNN-slug.md` and learn what was actually built. This section exists because nine task files
drifted: `Tasks/003` recorded its verification, and `001`–`002`, `004`–`009` and `023` all sat with
every acceptance box still open while nine commits of work sat in the tree.

**Run this before you say a task is done, in the same commit as the code.**

1. **Tick each acceptance criterion, with its evidence.** `[x]` plus a `path:line` citation naming the
   test that discharges it. `Tasks/003` is the model — every box names its test. **A tick with no
   citation is a claim, not a record.**
2. **Do not tick what was not verified.** Leave the box open and say why inline:
   - **UI-only** → `not verified: no frontend yet`. Never infer it from backend work.
   - **Platform** → `NOT RUN ON THIS HOST`, per §8a. This is the Linux half of `Tasks/001`.
   - **Partial** → say what exists and name precisely what is missing.
3. **Add a `**Status:**` paragraph** at the top of the task file: what was verified, on what host, on
   what date, with test counts. `Tasks/003` and `Tasks/004` show the shape.
4. **Update the state column in `PHASES.md`** to ✅, ◐ or ⬜. `PHASES.md` §Progress defines the three
   states and says plainly that they are not interchangeable.
5. **Correct every claim the code contradicts, in the same change.** §5a already makes a false written
   claim a bug; closing a task is when you find them. Five were found this way — see `PHASES.md`
   §Progress for what each one got wrong.

**The rule that catches the rest: a green test suite is not evidence that a task is done.** Prove it
by checking what is *unreachable*. As of this change, four components have full test coverage and **no
caller outside their own tests** — `resolve()`, `ApprovalQueue`, `QuestionGate`'s `note_call`/`reset`,
and `resolve_answer`. All four pass. None of them works. Before ticking a criterion, confirm the thing
is **wired into whatever uses it**, not merely implemented:

```
rg -n 'resolve\(\)|ApprovalQueue|note_call|bound_output' crates -g '*.rs'
```

A symbol appearing only in its own file and its own test is not done. Say so in the task file.

**Two traps this repo has already hit.** Check both by hand at close-out:

- **A test that passes without testing its name.** `tests/prompt.rs:47-55` calls `frozen_hash` twice
  with *identical arguments*. `tests/materialize.rs:139-153` asserts a pure function is deterministic
  where the criterion demanded three rejected mutation attempts. Read the assertion, not the name.
- **Structural proof is not observed proof, and must be labelled.** `Tasks/008`'s "deleting a chat
  leaves its memories" holds because the store has no `delete_thread` at all — unbreakable by
  construction, never exercised. Weaker than the criterion implies, and the file now says so.

## 8. What needs a human, not an agent

- **Changing a security claim.** `MISSION.md` §5 and `DESIGN.md` §3 are user-facing promises.
- **Disabling a feature on a platform.** `Tasks/001` may conclude that WebKitGTK will not hold an
  opaque origin. That is a release decision and the user is told in the product, not in a changelog.
- **Anything that raises the binary budget past ~25 MB.**
- **Taking anything from LobeHub.** Ever. If it looks like the only way, it is not.
- **Taking anything from Open WebUI beyond behaviour-mirroring.** The branding clause follows ported material. **D103.**
- **Renaming a decision.** D-numbers are permanent. Supersede, never renumber.

## 8a. Development and testing are Windows-only, for now

**Decided 2026-10-04.** Every local build, test run, and manual verification happens on **Windows /
WebView2**. Linux is a shipped target (`D88`) but it is **not** a development environment yet.

**What this means concretely:**

- The local toolchain is the Windows one: MSVC, `x86_64-pc-windows-msvc`, Windows-side node/npm.
  **No cross-compilation, and none is needed.**
- A probe, verdict, or measurement is **Windows-only until labelled otherwise**. Do not write
  "verified" next to a WebKitGTK claim on the strength of a Windows run — that is the exact
  substitution that makes a sandbox claim a lie.
- When a task's verdict table has a Linux column, it reads **"not run on this host"** until someone
  has actually run it on Linux. `Tasks/001` is the live example.
- The Linux half is executed by **CI on GitHub's runners**, never by an agent on a developer machine
  (`TECH_STACK.md` §8).

**Why now, and what "later" means.** WebKitGTK development headers are not installed on the
development host, and they need a sudo password an agent cannot supply non-interactively. Rather than
block Phase 0 on an environment setup, we take the WebView2 half now — `D89` already makes the
**WebView2 verdict the one that gates a release** and the WebKitGTK verdict best-effort.

**This is a sequencing decision, not a platform decision.** Linux remains a first-class shipped
platform and its CI floor remains a **release blocker** (`D50`, `Tasks/021`). Nothing here licenses
treating WebKitGTK as unverified-and-therefore-fine: when the headers are installed, the Linux
column gets filled in properly, and until then it stays empty.

---

## 8b. Windows shell tooling

Per §8a this is a Windows-only development environment. Applies on this host, and only where
the tool is actually installed — verify with `Get-Command <tool>` before relying on it.

**Installed:** GNU coreutils (uutils) at `C:\Program Files\coreutils\bin`, plus `rg`, `bat`,
`lsd`, `fzf`, `zoxide`, `btop`, `curl`, `uv`, `sqlite3`, `gh`, `xxd`, `git`.
**Not installed:** `jq`, `fd`, `delta`, `dust`, `eza`, `sd`, `lazygit`, `sed`, `awk` — the last
two exist only under `C:\Program Files\Git\usr\bin`, which is not on PATH. Anything outside
these two lists is unverified; check before use, don't assume.

**The trap.** PowerShell aliases shadow coreutils: bare `ls`, `cat`, `cp`, `mv`, `rm`, `sort`,
`echo`, `pwd`, `sleep`, `tee` are `Get-ChildItem`, `Get-Content`, `Copy-Item`, `Move-Item`,
`Remove-Item`, `Sort-Object`, `Write-Output`, `Get-Location`, `Start-Sleep`, `Tee-Object` — not
the real binaries. `ls -la` therefore errors or silently does something else. Use the dedicated
tool; where GNU semantics are genuinely required, use the `.exe` form.

| Never | Use instead |
|---|---|
| `Get-ChildItem -Recurse \| Select-String` | `rg -n <pattern>` |
| `Get-ChildItem -Recurse -Filter` | `rg --files -g '<glob>'` |
| `Get-Content <file>` | `bat -p <file>` |
| `Measure-Object -Line` | `wc -l` |
| `Copy-Item` / `Move-Item` / `Remove-Item -Recurse` | `cp.exe -r` / `mv.exe` / `rm.exe -r` |
| `Compare-Object` | `git diff --no-index` |
| `Test-Path` | `ls.exe <path>` |

`rg` is the default: gitignore-aware (so `target`, `node_modules`, `dist` are skipped when
ignored), parallel, PCRE2 via `-P`. Never assemble a recursive `Get-ChildItem |
Select-String` pipeline — on a Cargo workspace it is the slowest thing in the session. Note
§5's `grep -ri 'api[_-]?key\s*='` is the GNU `grep` from coreutils and works as written;
prefer `rg -i 'api[_-]?key\s*='` when a type or path glob narrows the search.

PowerShell stays correct for: registry, services, event logs, WMI/CIM, `Start-Process`,
`Invoke-RestMethod`, `Get-Command`, `cargo`, `pnpm`, and anything COM or .NET.

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