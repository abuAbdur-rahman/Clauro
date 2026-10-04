# Task 002 — Workspace skeleton and CI

**Phase** 0 · **Blocks** everything · **Decisions** TECH_STACK §2, D50 · **Contracts** none

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
- `rust-toolchain.toml`, `.nvmrc`, committed `Cargo.lock` + `package-lock.json`.
- `vitest` green with one trivial test, so the web test runner is proven before any UI exists.

## CI matrix

| Job | Purpose |
|---|---|
| `ubuntu-latest` | Linux primary |
| `ubuntu-22.04` | **Linux floor** — older WebKitGTK |
| `windows-latest` | Windows primary |
| `windows-2019` | **Windows floor** — older WebView2 |

Fail on drift, do not warn.

## Acceptance criteria

- [ ] `cargo test` green on all four jobs, headless
- [ ] `vitest` green
- [ ] Core crate has no dependency but `serde`, enforced
- [ ] `clauro-tools` → `tauri` dependency is a **failing** test, not a convention
- [ ] Locks committed; CI fails on drift
- [ ] `cargo build --release` artifact size measured and recorded as the baseline

## Note

Record the empty-shell binary size. That number is the denominator for every later size claim,
including Sucrase. Without it, "under 25 MB" is a claim rather than a measurement.
