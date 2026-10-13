# Task 022 — Packaging and dependency audit

**Phase** 6 · **Depends** `021` · **Decisions** D24, D39, D49, D59, D60
**Contracts** none

## Failing tests first

- **Binary size ≤ ~25 MB**, measured and asserted
- `models.dev/api.json` is **not** in the binary — assert on the artefact, not on intent
- Every dependency has a line in `TECH_STACK.md` §6
- A `NOTICE`-style attribution file lists all three MIT repos and **no** LobeHub
- No first-party prompt wording appears anywhere in the source tree
- `grep -ri 'api[_-]?key\s*='` finds nothing

## Do

**Measure, do not assert in prose.** The <15 MB claim was never measured; it was raised to ~25 MB on
evidence. The `002` baseline is the denominator. Record the final number.

**The largest known consumers beyond the shell** (be honest in the measurement, do not hide them):
Sucrase ~1 MB (`D4`) · the pre-built Tailwind (vendored, required by the
`style-src 'unsafe-inline' data: blob:` policy in `D83`) · the frontend bundle.

**Never bundle the model catalogue.** `models.dev/api.json` is ~5.3 MB — **larger than the entire
binary budget.** Fetch at runtime, cache, fail gracefully offline. `D23`.

**Distribution:**
- Windows — MSIX or NSIS; WebView2 evergreen bootstrapper with a **pre-paint detection and
  explanation** so a locked-down machine gets a message, not a blank window. `D49`, `D53`
- Linux — AppImage plus a package per distribution in the CI matrix. The matrix is the contract.

**Attribution is a release requirement, not a courtesy.** `D60`: OpenCode, DeepSeek Harness, and
LibreChat are MIT and may be ported — each port carries attribution in the file it lands in.
**LobeHub is observation-only; nothing may be taken from it** `D59`, and its licence reserves
unilateral amendment, so even a permissive reading today is not a stable grant.

**`D39` — no first-party wording anywhere in the tree.** Two MIT repos contain first-party prompt text
verbatim; MIT cannot relicense it. Our `fs` and `edit` prompts are written from scratch. Behaviour is
borrowed, wording is ours. **A verbatim quote from Anthropic's docs in this repo is a bug** — paraphrase
it and cite the URL.

**Re-audit `docs/dependencies.md` §6 — the open-advisory register.** One entry today: `glib`
(Dependabot #2, medium), range-blocked behind tauri's `gtk = ^0.18` chain, the block proven by
dry-run rather than asserted. At release every entry must be **fixed, backported, or explicitly
re-deferred with its reason refreshed** — never simply still open.

## Acceptance criteria

- [x] Binary measured and ≤ ~25 MB — **11,779,072 B = 11.23 MiB** (2026-10-13, Windows dev-host
      `cargo build --release`, cold 31m57s). Recorded in `docs/build-baseline.md`; asserted on every
      release build by `release.yml:166`. §8a caveat: the CI assertion on the shipped bundles is the
      authoritative one, not this host's.
- [x] Catalogue **not** bundled; verified in the artefact — eight catalogue-only provider slugs score
      **0** in `clauro.exe` **and** in `dist/`, with a positive control (the `models.dev/api.json`
      fetch URL *is* in the binary), and no `models-dev-cache.json` shipped.
- [x] Every dependency justified in `TECH_STACK.md` §6 — mechanical inventory 2026-10-13 resolved
      every direct cargo and npm dependency to a row; §7.1 now records the four type/tooling
      leftovers (`@types/*`, `@eslint/js`) as following their parents.
- [x] Attribution file lists the MIT repos, excludes LobeHub — `THIRD_PARTY_NOTICES.md` (four
      sources; shadcn/ui is component-code-only per **D127**), enforced by `check-docs.py` §10. "No
      LobeHub" is enforced as *no banned name in a source row* — the rule set's own wording, since
      naming an observation-only repo in a sentence is not a claim to have taken from it.
- [x] No first-party prompt or doc wording in the source tree — **one violation found and fixed**:
      `crates/clauro-loop/tests/run.rs` quoted an Anthropic doc fragment verbatim (**D39** calls that a
      bug); paraphrased, URL kept. A windowed check now guards the shape (`check-docs.py` §11), and a
      ±10-line audit found no others. **Not mechanical, stated rather than implied:** prompt *wording*
      (`fs`/`edit`) is review-enforced — those prompts are ours by construction, and D39 is a rule, not
      a corpus.
- [x] No secret material anywhere outside the keyring — the CI job `no secrets committed` fails on any
      key-shaped **value** (`git grep`, 16+ chars, lockfiles excluded). The literal
      `api[_-]?key\s*=` grep the task names has **7 hits and all 7 are benign**: two `keyring_store`
      *reads* (`turn.rs:991`, `:1353`), one prose line, and four synthetic fixtures that exist to test
      detection (`retention.test.ts:17`, `clauro-tools/tests/secret.rs:21`, `SettingsDialog.test.tsx:312`).
      The criterion's method predates the CI job; the job is strictly stronger.
- [x] Open advisories in `docs/dependencies.md` §6 cleared or explicitly re-deferred at release — the
      single entry (`glib`, Dependabot #2) is **re-deferred with its reason refreshed** 2026-10-13:
      block re-proved by dry-run, no `0.18.x` backport exists, and tauri 2.12.3 (2026-10-10) still
      requires `gtk ^0.18`.
- [ ] Windows install runs on a machine with no WebView2, and explains itself — **RELEASE-GATED, not
      verified here.** Needs a host without the runtime; the pre-paint boot gate exists
      (`App.tsx:72`), but "explains itself to a locked-down machine" is unproven on this box.
- [ ] Linux artefacts install and run on every floor in the matrix — **RELEASE-GATED.** Packaging
      runs in `release.yml`; no Linux packaging happened in this task.
- [ ] Both floors green at release time — **a release-time gate, not a task deliverable.** For the
      record: both floors were green on `fcc30c6` and on `7b70a76` (2026-10-13).

## Status

**Landed 2026-10-13 (Phase 6, branch `phase-6`; release-gated items above are labelled, not ticked).**
The verifiable half is done and enforced rather than described: the attribution notice with a
`check-docs.py` gate that has a negative control on each branch (§10); a windowed first-party-wording
gate that would have caught the one real violation it shipped alongside (§11, `crates/clauro-loop/tests/run.rs`);
the dependency inventory with its four type-package leftovers stated; the advisory re-audit with both
revisit triggers re-checked against the registry today; and the binary measured at **11.23 MiB**
against the ~25 MB budget, with the catalogue's absence from the artefact proven by a search that
carries its own positive control.

**Not verified, and named rather than implied:** windowed-guard completeness (it detects a quoted
fragment beside a citation, not reused wording in general); prompt-wording by construction (D39
review); the Windows bare-machine install, the Linux packaging matrix, and the release-time floor
gate (all release-gated per **D126**/`PHASES.md`); and the size number itself is dev-host, superseded
by the CI assertion on shipped bundles (§8a).
