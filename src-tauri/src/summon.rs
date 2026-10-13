//! Task 020 — the global summon hotkey and the single-instance guard.
//!
//! Two host facts, one report surface. `summon_hotkey_status` resolves to the
//! registered combo or rejects with the recorded reason, so the Shortcuts pane
//! can *say* why the global path is missing instead of silently degrading to
//! the in-app keydown listener (`src/features/shell/hotkey.ts`) — 020's
//! "conflicts handled by falling back … and saying so" clause. The slot is
//! filled once, during setup; an unfilled slot (a host that skipped setup)
//! rejects too, because the UI must never claim a global path that was not
//! proven.

use std::sync::Mutex;
use tauri::Manager;

/// The accelerator the host registers — Windows Ctrl-only per B05, the same
/// chord as the in-app listener. Mirroring the chord is the point: while the
/// shortcut is live the OS consumes Ctrl+K before the webview sees it (no
/// double-fire), and when registration failed — or the app runs in a plain
/// browser — the in-app listener below still works, unchanged.
pub const REGISTER_SOURCE: &str = "ctrl+k";

/// The displayed form of that combo (what the status command resolves to).
pub fn combo() -> String {
    "Ctrl+K".to_string()
}

/// The frontend event that carries "the host consumed your press": the OS
/// ate the keydown, so the press is re-delivered as this event instead.
pub const SUMMON_EVENT: &str = "clauro://summon";

/// The registration outcome. Setup is the only writer; the command only
/// reads. A poisoned lock is unwrapped to its inner value, never a panic —
/// nothing throws across the tool boundary (D55).
static STATUS: Mutex<Option<Result<(), String>>> = Mutex::new(None);

/// Record the registration outcome (called once, from setup).
pub fn record(outcome: Result<(), String>) {
    let mut slot = STATUS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *slot = Some(outcome);
}

/// Pure mapping of a recorded outcome to the command payload: registered →
/// the combo; a conflict → the host's reason; never attempted → a reason as
/// well. `None` must never read as success: the boundary reports what
/// happened, not what we wish had.
pub fn status_payload(slot: Option<Result<(), String>>) -> Result<String, String> {
    match slot {
        Some(Ok(())) => Ok(combo()),
        Some(Err(reason)) => Err(reason),
        None => Err("hotkey registration was never attempted".to_string()),
    }
}

/// The status command (the 21st): resolves to the registered combo, or
/// rejects with the recorded reason. The frontend maps either shape into a
/// typed status — `summonHotkeyStatus` never throws.
#[tauri::command]
pub fn summon_hotkey_status() -> Result<String, String> {
    let slot = STATUS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    status_payload(slot)
}

/// Bring the main window forward — the single-instance handoff and the
/// global press both funnel here. Each window call is best-effort: a window
/// that is already gone is a reason to no-op, not to fail the event that
/// asked (D55).
pub fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The OS consumed Ctrl+K before the webview could see it, so re-deliver the
/// press: focus the window first, then let the frontend open the palette on
/// `SUMMON_EVENT` (bridged in `useSummonHotkey`).
pub fn on_global(app: &tauri::AppHandle) {
    use tauri::Emitter as _;
    focus_main(app);
    let _ = app.emit(SUMMON_EVENT, ());
}
