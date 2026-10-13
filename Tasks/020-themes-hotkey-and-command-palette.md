# Task 020 — Themes, global hotkey, command palette

**Phase** 5 · **Depends** `002` · **Decisions** D42, D44, D66
**Contracts** none (UI behaviour)

## Failing tests first

- The palette opens from anywhere, including while a tool approval dialog is open → **it does not**
- A palette action that would open a new thread while a turn is running is refused with a reason
- `/compact` in the palette is unavailable during an in-flight turn
- The hotkey is globally registered and released cleanly on quit
- A second instance activates the first rather than launching a second
- Theme switches with no flash of the wrong theme
- Density and accent changes apply without a reload

## Do

**Keyboard-first.** A desktop client is judged on this before anything else. The palette is the
keyboard surface: every action reachable without a pointer, in a predictable order, with the
shortcut shown.

**Global hotkey.** Summon the window from anywhere; focus an existing instance rather than launching
a second. Conflicts handled by falling back to an in-app shortcut and saying so, not by silently
doing nothing.

**Three controls, one place** (`D42`, `D66`, `D44`) — the palette is where the sharp edges collect,
so it needs explicit states:
- `/compact` — unavailable mid-turn, with the reason shown
- `bash` — **approve/reject never live here.** Approval is a blocking dialog with the exact command
  and working directory. It is not a palette action, because a palette entry is too easy to hit by
  reflex and this is the one action that must never be reflexive
- `attach` — **designed, not built** (`D44`). Do not wire it up; if `fs` proves too confined it is the
  first thing to add, and it should arrive as a real feature, not a stub

**Themes.** light / dark / system, accent, density. Applied without a flash — set the initial theme
before first paint, from the OS preference when `system` is selected.

## Acceptance criteria

- [x] Every action reachable from the keyboard — arrow/Enter select-and-close `src/features/shell/CommandPalette.test.tsx:187`, Escape through the focus trap `:227`, kbd hints footer `:64`
- [x] Hotkey registers globally; releases cleanly; no duplicate instances — global status mapping `src/features/shell/hotkey.test.tsx:78`, builder wiring (shortcut + single-instance) `src-tauri/src/lib.rs:734`, status line `src/features/settings/SettingsDialog.test.tsx:256`; release-on-quit is plugin lifecycle with no dedicated assertion (labelled §7a — registration re-proven across every relaunch)
- [x] Palette blocked, with a reason, while a turn is running — `src/features/shell/shell.test.ts:7`, reason render `src/features/shell/CommandPalette.test.tsx:108`
- [x] `/compact` unavailable mid-turn — `src/features/shell/shell.test.ts:7`
- [x] `bash` approval is **not** reachable from the palette — `src/features/shell/shell.test.ts:14` (`not.toContain("bash:approve")` at `:16`)
- [x] `attach` absent — `src/features/shell/shell.test.ts:14`
- [x] Theme switch with no flash of the wrong theme — pre-paint apply `src/features/shell/usetheme.test.tsx:31`, resolve-without-flash `src/features/shell/shell.test.ts:32`; live in a real engine 2026-10-13: dark↔light token flip with no reload
- [x] Density and accent apply live — `src/features/settings/SettingsDialog.test.tsx:164` + `:173`, density cascade pin `src/styles.test.ts:46`; live in a real engine 2026-10-13: root 17px ↔ 15px, accent ring moves

## Status — 2026-10-13 ✅

All eight criteria green. Live on the running proof binary and the mock web harness (same bundle):
Settings → Shortcuts pinned the registered status line; the palette rendered and executed an action
end to end; Ctrl+K moved focus across windows while Notepad's own Ctrl+K (close-tab) never fired —
OS-level interception, not an in-app listener; a second launch held two processes transiently and
settled to one window; the 21-command surface is pinned by `src-tauri/src/lib.rs:675`; appearance
switched live in a real engine — theme tokens flip with no reload, the accent selection applies, and
density resizes the root 17px ↔ 15px.

That last probe found a real defect: the compact rule sat in `@layer base` while the unlayered
`html { font-size: 17px }` outranks every layer regardless of specificity, so density wrote its
attribute and changed nothing — fixed by moving the rule beside the base rule (`src/styles.css`),
pinned by `src/styles.test.ts:46`, which was red on the shipped file.

Labelled unverified (§7a): live Escape/X dismissal was raced by foreground activity on the proof
host (unit coverage `CommandPalette.test.tsx:227`); keypress delivery for the in-app chord beyond
Ctrl+K is test-covered only. Plugins adopted with records: `docs/dependencies.md` §4.7/§4.8,
`TECH_STACK.md` §6.2/§7.1.
