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
