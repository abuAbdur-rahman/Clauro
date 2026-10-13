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

- [x] B07 Date groups — DONE (`ProjectsRail.tsx:115` `groupRailChats` buckets pinned/today/yesterday/prev-7/older, called at `:287`; `ProjectsRail.test.tsx:172` buckets, `:190` omits empty + sorts newest-first; the mock SEED has its own pure port at `seed.ts:253`).
- [ ] B08 No row menu (Pin/Rename/Move/Export/Delete); vendored `dropdown-menu` orphaned.
- [ ] B09 No inline rename; no move-to-project submenu.
- [ ] B10 No active-row 3px accent bar.
- [x] B11 Thread status indicator — DONE Task 029 (rail UI + `thread.ts` `statusOf/markRead/markUpdated/setRunning` + `App.tsx` wiring `statusByThread`/viewed-on-open; `thread.test.ts` +10, indicator 2/2).
- [x] B12 Send dead-ends — DONE Task 031 T8 (home text stages via store drafts + auto-sends on chat mount; rail selection opens the clicked thread id; `artifact_latest` honest null in mock; Ctrl+N wired).

## P2 — chat/transcript/composer

- [ ] B13 Hardcoded `THREAD=thread-001`, `DEMO_PROJECTS` — no thread CRUD.
- [ ] B14 Message actions absent (copy/regen/branch/thumbs); regen must append, never pop (D19).
- [x] B15 Scroll-follow + Jump-to-latest + `FrameCoalescer` — DONE (`ChatView.tsx:71-292` stick-to-bottom: follows new rows only while stuck within 48px, `setStuck` at `:286`, snaps at `:292`; `:295` `jumpToLatest` + the pill at `:351-355`, tested at `ChatView.test.tsx:538`; `FrameCoalescer` is imported and used at `ChatView.tsx:158`, not unwired).
- [x] B16 Context bar — DONE (`ChatView.tsx:361` `data-testid="context-bar"`, honest estimate `tokens ≈ chars/4` computed at `:77-83`, shown as `Context {pct}% used` at `:365` with the ` / · estimate` label at `:362`; empty-transcript hide + the estimate itself tested at `ChatView.test.tsx:422` and `:443`). `usage` is consumed, not discarded.
- [x] B17 Composer surface — DONE for every behavioural half (`Composer.tsx:277-288` slash query + filter, keyboard nav at `:460-473`, menu rendered at `:559-575`; Ctrl+B/I/E inline wrap at `:402-418` with Ctrl+Shift+K fence at `:419`; token hint `data-testid="token-hint"` at `:769-773` labelled "· estimate"; `sendWith` prop at `:172` honoured at `:458-545` with the settings page persisting it at `SettingsDialog.tsx:284`; IME guard at `:393-396` — no chord fires mid-composition; Stop swaps in place at `:813-825`; chat-view attach is real at `ChatView.tsx:390`). **Two halves remain open:** the textarea is still **unbounded** (no `maxLength`, no cap on `draft`), and the **home** composer still passes `onAttach={noop}` (`App.tsx:586`) — so D47 attachments work in a chat but not from the empty-state screen.
- [ ] B18 `transcript_read` mock returns `[]` — real must read SQLite; empty honest ok, fake rows never.

## P2 — settings/providers

- [ ] B19 Settings 3/8 pages; no search box; Appearance lacks accents + font-size (`"neutral"` hardcode `usetheme.ts:42`).
- [ ] B20 Shortcuts 2/8; no single `lib/shortcuts.ts` hook.
- [ ] B21 Toasts absent repo-wide (sonner 0 hits).
- [ ] B22 Palette trap (`CommandPalette.tsx:35` no `onOpenChange`); content thin (4 strings); `DeleteConfirm` undismissable.
- [ ] B23 `CustomForm` no client zod; errors only after `invoke`.

## P2 — projects/artifacts/onboarding

- [ ] B24 Projects `onNew={noop}`, detail read-only (`instructions=""`, `"0%"`), grid name-only, name-only search, no empty state.
- [x] B25 Artifact producer + drawer — DONE (`live.ts:135` `useArtifactProducer`, the D121 production wiring, called at `ChatView.tsx:98`; the content store `useArtifactContent` at `live.ts:48` is set from turn events at `:158` and consumed by the shell at `App.tsx:335`, reaching the drawer as `source={artifactContent?.source ?? ""}` at `:704` — an honest empty when the thread has no artifact, not a hardcoded dead string). End-to-end: `ChatView.test.tsx:390` asserts the produced source lands in the store. **Still open, unchanged:** D123/D124 transport must hold in both modes (served doc, `artifact` host, no `srcdoc` shortcut in mock) — that half of the row was never about the producer.
- [ ] B26 Onboarding absent (`rg -i onboard src` = 0).
- [ ] B27 `neutral-*` hardcodes (`TranscriptView UserRow`, `ArtifactDrawer`, `App.tsx:106`) vs token rule.
- [ ] B28 Rule-4 reason comments missing on 6 non-shadcn `ui/` files.

## Mock-only honesty rules (not blockers, must hold)

- Timers deterministic; `data-testid` on every interactive node; `?seed` param.
- Fake latency/tests labeled simulated; hardcoded `v1`/`42%`/`2.4MB` computed or labeled sample.
- `groupDates` toggle wired or dropped; `edit.save` guarded; timer registry cleared on view switch.
