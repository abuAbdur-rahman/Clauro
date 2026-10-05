# Empty-shell binary baseline (Task 002, re-measured with 003)

Recorded 2026-10-04. The denominator for every later size claim, including Sucrase.

| | |
|---|---|
| Binary | `target/release/clauro.exe` (workspace target dir) |
| Size | **8.08 MB** — measured 13:18, 2026-10-04, including the 003 additions (`keyring`, `reqwest`, catalogue + picker) |
| Profile | release: `codegen-units = 1`, `lto = true`, `opt-level = 3`, `panic = "abort"`, `strip = true` — declared at the **workspace root** |
| Tauri | `=2.12.1` / `tauri-build =2.7.1` |
| Rust | 1.96.0 (`rust-toolchain.toml`) |
| Frontend | 003 UI: boot gate + model picker, Tailwind utilities |
| Budget | ~25 MB (`MISSION.md`). Headroom: **~17 MB**. |

**Correction, kept visible (AGENTS.md §5a — a false claim in a spec is a bug).** The original
record read **8.75 MB** with the profile row above. That pairing was wrong: the `[profile.release]`
table then lived in `src-tauri/Cargo.toml`, where Cargo **ignores it for non-root workspace members**
(it prints `profiles for the non root package will be ignored`). So the 8.75 MB build ran on the
default release profile — no LTO, no strip — and the profile row described a configuration that was
not in effect. Moving the table to the root `Cargo.toml` is what made the profile real; the same
build then measured **8.08 MB**, *smaller despite two added dependencies*. The 8.75 figure is kept
here rather than deleted so the discrepancy cannot be rediscovered as a mystery.

Re-measure on every dependency addition that touches the shell or the bundle.

## Re-measurement — 2026-10-05, `Tasks/014` (artifact compile, CSP, channel)

`D4` named Sucrase as "the single largest known contributor to the binary budget beyond the shell
itself" and put it at ~1 MB. **Both halves of that were wrong, and the correction is kept visible
rather than quietly rewritten (`AGENTS.md` §5a).** Sucrase is a *frontend* dependency, so it never
touches `clauro.exe` at all — the Rust binary moved from 8.08 MB to **8.00 MB**, i.e. noise in the
wrong direction (three added `str` literals and one module). The real cost is the bundle, and it is
not ~1 MB.

| Asset | Bytes | Loads when |
|---|---|---|
| `clauro.exe` (release) | **8.00 MB** — was 8.08 MB | always |
| `index-*.js` (main chunk) | **340.76 kB** (104.63 kB gzip) — was **325.35 kB** (99.22 kB gzip) | always |
| `compile.worker-*.js` | **202.65 kB** | only when an artifact has JSX to compile |
| `purify.es-*.js` | **28.08 kB** (11.08 kB gzip) | only when an artifact is SVG |
| `index-*.css` | 10.45 kB — unchanged | always |

**Main chunk: +15.4 kB**, and that is the whole honest cost of this task. The two large pieces are
in separate chunks because `D4` says exactly that: Sucrase is reachable only from
`compile.worker.ts`, and DOMPurify is behind a dynamic import. An earlier draft of this work had
Sucrase statically imported by the host-side `compile.ts` and DOMPurify statically imported by
`sanitize.ts` — together +100 kB in the chunk every launch pays for. Two tests now fail if either
regresses (`compile.test.ts` import graph, `sanitize.test.ts` dynamic import).

Headroom against the ~25 MB budget is therefore unchanged: **~17 MB**, and the artifact pipeline
spent 15 kB of it rather than the megabyte `D4` feared.
