# Blockers — real must be 100% real, same state as mock

**Purpose:** every gap where real UI today is mock/demo/empty. Real ships only when row clears. Mock may fake; real must fail loudly, never fake. (User decision 2026-10-10.)

**Modes:** real = `pnpm tauri dev` (1420, Rust). Mock = `pnpm dev:mock` (1430, web-only, enriched `mock-tauri.ts` + TS SEED). Visual truth = `docs/references/ui/index.html`; `01–10.png` secondary.

## P1 — shell/chrome

- [x] B01 Custom titlebar — DONE Task 029 (`src/app/TitleBar.tsx`: 32px, drag region, 46×32 caps, close `#C42B1C`; `tauri.conf.json` `decorations:false`; dynamic-only window import so mock/web boot unaffected). §8a visual pending.
- [x] B02 Sidebar hangs — FIXED Task 029 (`App.tsx:107-111` flush layout, `ProjectsRail.tsx:84` `h-full min-h-0 self-stretch`, 56px `w-14`). §8a visual pending.
- [x] B03 Rail width — FIXED Task 029 (`ProjectsRail.tsx:84` `w-14` = 56px; `ProjectsRail.test.tsx:122` updated).
- [x] B04 Collapse persisted to cookie — DONE Task 029 (`sidebar.tsx`: `clauro.sidebar` localStorage try/catch, read on init; `sidebar.persistence.test.tsx` 3/3).
- [x] B05 `metaKey` accepted — DONE Task 029 (dropped in `hotkey.ts` + sidebar Ctrl+B; `hotkey.test.tsx` asserts Meta does not fire).
- [ ] B06 No reduced-motion rule; no 900px min; no 1100px artifact overlay as Sheet.

## P1 — thread list + indicator

- [ ] B07 No date groups (Pinned/Today/Yesterday/7d/Older) — `groupChats` missing.
- [ ] B08 No row menu (Pin/Rename/Move/Export/Delete); vendored `dropdown-menu` orphaned.
- [ ] B09 No inline rename; no move-to-project submenu.
- [ ] B10 No active-row 3px accent bar.
- [x] B11 Thread status indicator — DONE Task 029 (rail UI + `thread.ts` `statusOf/markRead/markUpdated/setRunning` + `App.tsx` wiring `statusByThread`/viewed-on-open; `thread.test.ts` +10, indicator 2/2).
- [ ] B12 New chat `noop` (`App.tsx:115`); Ctrl+N missing; home `onSend={noop}` (`App.tsx:144`) dead-ends.

## P2 — chat/transcript/composer

- [ ] B13 Hardcoded `THREAD=thread-001`, `DEMO_PROJECTS` — no thread CRUD.
- [ ] B14 Message actions absent (copy/regen/branch/thumbs); regen must append, never pop (D19).
- [ ] B15 No scroll-follow + Jump-to-latest; `FrameCoalescer` unwired.
- [ ] B16 No context bar (70/90%); `usage` parsed then discarded.
- [ ] B17 Composer: no slash menu, no Ctrl+B/I/E, no token hint, no `sendWith`/IME guard, textarea unbounded, Stop not in-place, attach `noop` advertises D47.
- [ ] B18 `transcript_read` mock returns `[]` — real must read SQLite; empty honest ok, fake rows never.

## P2 — settings/providers

- [ ] B19 Settings 3/8 pages; no search box; Appearance lacks accents + font-size (`"neutral"` hardcode `usetheme.ts:42`).
- [ ] B20 Shortcuts 2/8; no single `lib/shortcuts.ts` hook.
- [ ] B21 Toasts absent repo-wide (sonner 0 hits).
- [ ] B22 Palette trap (`CommandPalette.tsx:35` no `onOpenChange`); content thin (4 strings); `DeleteConfirm` undismissable.
- [ ] B23 `CustomForm` no client zod; errors only after `invoke`.

## P2 — projects/artifacts/onboarding

- [ ] B24 Projects `onNew={noop}`, detail read-only (`instructions=""`, `"0%"`), grid name-only, name-only search, no empty state.
- [ ] B25 Artifact unreachable: `source=""` (`App.tsx:224`), no producer, card dead text. D123/D124 transport must hold in both modes (served doc, `artifact` host, no `srcdoc` shortcut in mock).
- [ ] B26 Onboarding absent (`rg -i onboard src` = 0).
- [ ] B27 `neutral-*` hardcodes (`TranscriptView UserRow`, `ArtifactDrawer`, `App.tsx:106`) vs token rule.
- [ ] B28 Rule-4 reason comments missing on 6 non-shadcn `ui/` files.

## Mock-only honesty rules (not blockers, must hold)

- Timers deterministic; `data-testid` on every interactive node; `?seed` param.
- Fake latency/tests labeled simulated; hardcoded `v1`/`42%`/`2.4MB` computed or labeled sample.
- `groupDates` toggle wired or dropped; `edit.save` guarded; timer registry cleared on view switch.
