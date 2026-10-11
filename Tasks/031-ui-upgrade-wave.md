# Task 031 — UI upgrade wave (html parity + impeccable floor)

**Phase** 6 · **Depends** `029`, `030` · **Decisions** D112
**Contracts** none — visual + mock-behavior only; no wire shapes change

**Brief (Operate mode):** match `docs/references/ui/index.html` (live ref
http://localhost:1440; mock http://localhost:1430). Impeccable floor applies:
contrast ≥4.5:1, themed scrollbars/selection/caret/focus (never browser
defaults), lucide icons one stroke/weight (never unicode/emoji), all states
(hover/disabled/loading/error/empty), no nested cards, no kicker labels.

**Status: open.** 7 thread-safe groups (disjoint files — check `git status`
before touching anything outside your list):

- [ ] T1 Dialogs beauty → `SettingsDialog.tsx`/test, `CommandPalette.tsx`/test,
      `palette.ts`, `settings.ts`. Match html dialog chrome (header, search,
      nav, row rhythm, kbd chips). (Issue 1)
- [ ] T2 Projects page → `ProjectsGrid.tsx`/test, `ProjectDetail.tsx`/test,
      `projects.ts`/test. Grid + detail to html; Back = chevron icon button
      (no "<- Back" text). (Issues 2, 8-partial)
- [ ] T3 Theme + scrollbars + sizes → `styles.css` ONLY. Sidebar/main bg delta
      per html (#eee/#fff light, #1b/#2b dark, in-token); overlay thin styled
      scrollbars app-wide (no native Win32 bars anywhere); min-width 900px.
      (Issues 3, 5, 10-partial)
- [ ] T4 Rail folders → `ProjectsRail.tsx` + tests. Folder icon per project,
      hover chevron up/down, collapsible threads, keep groups/dots/menus.
      (Issue 4)
- [ ] T5 Working mock threads → `mock-tauri.ts` + test, `seed.ts` + test,
      `ChatView.tsx` + test. Mock MODE: seed transcript visible, send streams
      a seed reply (typing dots → word stream → done), thinking region,
      auto seed model (no "model none" dead-end). Real path untouched
      (dynamic import, MODE branch). (Issue 6)
- [ ] T6 App shell → `App.tsx` + tests, `tauri.conf.json` (window 1200×800
      confirm), wire ALL hotkey hooks in App, replace remaining "<- Back"
      text buttons with chevron icons, confirm layout sizes vs html §10.
      (Issues 8, 9, 10)
- [ ] T7 Composer polish → `Composer.tsx`/test, `ModelPicker.tsx`/test.
      Icon toggles (memory/effort/web/think) with tooltips, effort = thinking
      level indicator, model chip, token hint, keep slash/keys/stop.
      (Issue 7)
- [ ] T8 Verify (sequential, after T1–T7): capture every screen vs html,
      full gates, report. NOT parallel.

## Acceptance criteria

- [ ] Side-by-side captures per screen in `.openchamber/screenshots/`
- [ ] `tsc` + `eslint` clean, full suite green
- [ ] No `any`, no console.log, zero static `@/mock` in real code
- [ ] Tooling notes: `browser.snapshot` wedges on React pages (use capture+read);
      html page snapshots fine; kill stray servers you start
