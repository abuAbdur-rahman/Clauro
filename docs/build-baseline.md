# Empty-shell binary baseline (Task 002)

Recorded 2026-10-04. The denominator for every later size claim, including Sucrase.

| | |
|---|---|
| Binary | `target/release/clauro.exe` (workspace target dir) |
| Size | **8.75 MB** |
| Profile | release: `codegen-units = 1`, `lto = true`, `opt-level = 3`, `panic = "abort"`, `strip = true` |
| Tauri | `=2.12.1` / `tauri-build =2.7.1` |
| Rust | 1.96.0 (`rust-toolchain.toml`) |
| Frontend | skeleton only — one placeholder view, Tailwind utilities |
| Budget | ~25 MB (`MISSION.md`). Headroom: **~16 MB**. |

Re-measure on every dependency addition that touches the shell or the bundle.
