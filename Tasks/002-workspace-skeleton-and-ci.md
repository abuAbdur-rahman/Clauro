# Task 002 — Workspace skeleton and CI

**Phase** 0 · **Blocks** everything · **Decisions** TECH_STACK §2, D50 · **Contracts** none

**Status: complete, with one real defect and one naming problem. Re-verified 2026-10-04.**
`cargo test --workspace` green headless (48 suites, 167 tests); `vitest` green (4 files, 17 tests);
both dependency rules enforced by passing tests.

Two things this task's own text claims that CI does not deliver. **Cargo lock drift is not enforced** —
`.github/workflows/ci.yml:134` runs `cargo test --workspace` with no `--locked`, so a stale
`Cargo.lock` silently updates instead of failing the build. `release.yml:61` carries the comment
"`--locked` is not optional in CI. It is the difference between 'reproducible' and 'usually the
same'"; the job that matters does not take its own advice. And **the two floor jobs are not yet
floors** — `ci.yml:119-122` is a `Write-Host` placeholder that pins nothing, and `linux floor` is
byte-identical to `linux primary`. The matrix labels exist; `D50`'s guarantee behind them does not.
Both are one-line fixes and belong to `Tasks/021`.

## Failing test first

```
cargo test -p clauro-core
```
must be runnable with **no display and no webview**. If it needs one, the workspace layout is wrong
and every later promise in `CONTRACTS.md` §7 is unpayable.

## Build

```
clauro/
├─ crates/{core,store,transport,tokens,tools,fs}
├─ src-tauri/
└─ src/
```

- `clauro-core` depends on nothing but `serde`. Enforce with a test or a CI dep check.
- **A test asserting `clauro-tools` does not depend on `tauri`.** Make the rule mechanical, not a
  convention someone breaks quietly.
- `rust-toolchain.toml`, `.nvmrc`, committed `Cargo.lock` + `pnpm-lock.yaml`.
- `vitest` green with one trivial test, so the web test runner is proven before any UI exists.

## CI matrix

The task text originally named `ubuntu-22.04` and `windows-2019` here. Both labels were untestable
and were corrected by audit — see `TECH_STACK.md` §5, which is authoritative. The matrix that runs
is `.github/workflows/ci.yml`:

| Job | Purpose |
|---|---|
| `ubuntu-24.04` | Linux primary — WebKitGTK system version |
| `ubuntu-24.04` | **Linux floor** — oldest runner with a meaningful WebKitGTK |
| `windows-latest` | Windows primary — evergreen WebView2 |
| `windows-latest` + Fixed Version runtime | **Windows floor** — pinned WebView2, not an older OS image |

Fail on drift, do not warn.

## Acceptance criteria

- [x] `cargo test` green on all four jobs, headless — all four jobs defined
      (`.github/workflows/ci.yml:53-61`) and all four concluded `success` on run 37240757751.
      Locally: 48 suites, 167 tests, 0 failed, no display. **But see Status** — the two "floor"
      jobs do not yet pin a floor runtime
- [x] `vitest` green — `package.json:13` (`vitest run`), the required trivial headless test at
      `src/skeleton.test.ts:8-13`; 4 files / 17 tests pass locally, vitest 5.0.3; wired at
      `ci.yml:136-142`
- [x] Core crate has no dependency but `serde`, enforced —
      `crates/clauro-core/Cargo.toml:7-8` (`serde` only);
      `crates/clauro-core/tests/no_extra_deps.rs:41-52` asserts the set is exactly `{serde}`.
      Mechanical, not conventional, and `no_extra_deps.rs:65-70` is a negative control proving the
      scanner can fail
- [x] `clauro-tools` → `tauri` dependency is a **failing** test, not a convention —
      `crates/clauro-tools/tests/no_tauri_dep.rs:30-39`; `cargo tree -p clauro-tools -i tauri`
      returns no match. Gap: this test has no negative control, so it has never been observed red
      (`AGENTS.md` §6), and it scans only its own `[dependencies]`, not transitively
- [ ] Locks committed; CI fails on drift — **PARTIAL.** `Cargo.lock`, `pnpm-lock.yaml`,
      `rust-toolchain.toml`, `.nvmrc` are all tracked; JS drift is enforced at `ci.yml:139`
      (`--frozen-lockfile`). **Cargo drift is not** — `ci.yml:134` omits `--locked`. See Status
- [x] `cargo build --release` artifact size measured and recorded as the baseline —
      `docs/build-baseline.md:8` — **8.08 MB**, measured 13:18 2026-10-04; ~17 MB headroom against
      the ~25 MB budget (`:13`). The doc also keeps the superseded 8.75 MB figure visible with the
      reason it was wrong (`:15-22`) — the correction discipline `AGENTS.md` §5a asks for

## Note

Record the empty-shell binary size. That number is the denominator for every later size claim,
including Sucrase. Without it, "under 25 MB" is a claim rather than a measurement.
