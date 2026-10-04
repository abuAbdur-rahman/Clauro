//! `clauro-tools`: the eight handlers + registry + permission resolution.
//!
//! `CONTRACTS.md` §3. Dependencies point inward: this crate may use
//! `clauro-core`, never `tauri`. The only crate that knows Tauri exists is
//! `src-tauri`. Enforced mechanically in `tests/no_tauri_dep.rs`.

/// Placeholder. Real handlers land with the tasks that own them.
pub fn placeholder() -> bool {
    true
}
