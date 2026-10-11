# Task 032 — Interaction + layout pass (shortcuts, dead buttons, chat dock)

**Phase** 6 · **Depends** `031` · **Decisions** D112
**Contracts** none — behavior/visual only

**Brief (Operate):** html truth `docs/references/ui/index.html`
(image-1 = floating composer + context bar + actions; image-2 = current gaps).
Impeccable floor: every button acts or is disabled-with-reason; kbd chips;
sticky regions; contrast; focus.

**Status: open.** 4 thread-safe groups (disjoint files):

- [ ] U1 Menu + shortcuts → `ProjectsRail.tsx` + tests, `SettingsDialog.tsx`
      (shortcuts page only) + test. Profile menu: Shortcuts ENABLED → opens
      settings shortcuts page (wire via settings store section + onOpenSettings
      prop; add `onOpenShortcuts` if needed). Shortcuts page = real kbd table
      per html (8 rows, kbd chips, desc column). (Issues 1, 2)
- [ ] U2 Shell actions audit → `App.tsx` + tests. New-chat (+) creates thread
      + opens chat (verify live); audit EVERY App-level button (New chat,
      Search, Projects, Browse, model chip, footer): acts or disabled+reason.
      No stagnant buttons. (Issue 3)
- [ ] U3 Chat dock → `ChatView.tsx` + test, `Composer.tsx` + test. Column
      `h-full`: transcript `flex-1 overflow-y-auto` (own scroller), composer
      `shrink-0` docked bottom (never scrolls away); stick-to-bottom on new
      rows when near bottom; context bar above composer (progress + Compact,
      from `ui/progress`; estimate = chars/4 honest); composer `+` (attach)
      must open file picker or be disabled-with-reason — never noop.
      (Issues 3-partial, 5-critical)
- [ ] U4 Page frames → `ProjectsGrid.tsx` + test, `ProjectDetail.tsx` + test,
      `styles.css` (page-frame tokens only: card borders, section margins).
      Definite border/margin/box rhythm per html on every page (grid, detail,
      settings host, chat col). (Issue 4)

## Acceptance criteria

- [ ] Live captures: shortcuts page, new-chat creates+opens, docked composer
      with scrolled transcript, project frames
- [ ] `tsc` + `eslint` clean, full suite green
- [ ] Impeccable verify pass on the diff before commit (states, contrast,
      kbd, no dead buttons) — main thread runs it
