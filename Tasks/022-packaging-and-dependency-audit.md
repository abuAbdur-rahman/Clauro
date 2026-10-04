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

- [ ] Binary measured and ≤ ~25 MB
- [ ] Catalogue **not** bundled; verified in the artefact
- [ ] Every dependency justified in `TECH_STACK.md` §6
- [ ] Attribution file lists the three MIT repos, excludes LobeHub
- [ ] No first-party prompt or doc wording in the source tree
- [ ] No secret material anywhere outside the keyring
- [ ] Open advisories in `docs/dependencies.md` §6 cleared or explicitly re-deferred at release
- [ ] Windows install runs on a machine with no WebView2, and explains itself
- [ ] Linux artefacts install and run on every floor in the matrix
- [ ] Both floors green at release time
