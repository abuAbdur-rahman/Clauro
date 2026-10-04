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

- [ ] Every action reachable from the keyboard
- [ ] Hotkey registers globally; releases cleanly; no duplicate instances
- [ ] Palette blocked, with a reason, while a turn is running
- [ ] `/compact` unavailable mid-turn
- [ ] `bash` approval is **not** reachable from the palette
- [ ] `attach` absent
- [ ] Theme switch with no flash of the wrong theme
- [ ] Density and accent apply live
