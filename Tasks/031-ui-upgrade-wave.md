# Task 031 — UI upgrade wave (html parity + impeccable floor)

**Phase** 6 · **Depends** `029`, `030` · **Decisions** D112
**Contracts** none — visual + mock-behavior only; no wire shapes change

**Brief (Operate mode):** match `docs/references/ui/index.html` (live ref
http://localhost:1440; mock http://localhost:1430). Impeccable floor applies:
contrast ≥4.5:1, themed scrollbars/selection/caret/focus (never browser
defaults), lucide icons one stroke/weight (never unicode/emoji), all states
(hover/disabled/loading/error/empty), no nested cards, no kicker labels.

**Status: T1–T6 landed in `65e46f4`; T7 partial (Composer only); T8 not run.** Closed out
2026-10-12 per §7a — evidence below, missing work stated rather than ticked. 7 thread-safe groups
(disjoint files — check `git status` before touching anything outside your list):

- [x] T1 Dialogs beauty → `SettingsDialog.tsx`/test, `CommandPalette.tsx`/test,
      `palette.ts`, `settings.ts`. Match html dialog chrome (header, search,
      nav, row rhythm, kbd chips). (Issue 1) — `65e46f4`
      (`SettingsDialog.tsx` +204/−, `CommandPalette.tsx` +156/−, both tests +).
- [x] T2 Projects page → `ProjectsGrid.tsx`/test, `ProjectDetail.tsx`/test,
      `projects.ts`/test. Grid + detail to html; Back = chevron icon button
      (no "<- Back" text). (Issues 2, 8-partial) — `65e46f4`
      (`ProjectsGrid.tsx`, `ProjectDetail.tsx` + tests).
- [x] T3 Theme + scrollbars + sizes → `styles.css` ONLY. Sidebar/main bg delta
      per html (#eee/#fff light, #1b/#2b dark, in-token); overlay thin styled
      scrollbars app-wide (no native Win32 bars anywhere); min-width 900px.
      (Issues 3, 5, 10-partial) — `65e46f4` (`styles.css` +124). NOTE: the
      900px `#root` guard was later removed by audit 32 (responsive finding,
      fixed 2026-10-12) — that supersedes this criterion deliberately.
- [x] T4 Rail folders → `ProjectsRail.tsx` + tests. Folder icon per project,
      hover chevron up/down, collapsible threads, keep groups/dots/menus.
      (Issue 4) — `65e46f4` (`ProjectsRail.tsx` +122/−, test +87).
- [x] T5 Working mock threads → `mock-tauri.ts` + test, `seed.ts` + test,
      `ChatView.tsx` + test. Mock MODE: seed transcript visible, send streams
      a seed reply (typing dots → word stream → done), thinking region,
      auto seed model (no "model none" dead-end). Real path untouched
      (dynamic import, MODE branch). (Issue 6) — `65e46f4`
      (`mock-tauri.ts` +162/−, `seed.ts` +44, `ChatView.tsx` +31, all tests +);
      capture `.openchamber/screenshots/031-t5-working-thread.png`.
- [x] T6 App shell → `App.tsx` + tests, `tauri.conf.json` (window 1200×800
      confirm), wire ALL hotkey hooks in App, replace remaining "<- Back"
      text buttons with chevron icons, confirm layout sizes vs html §10.
      (Issues 8, 9, 10) — `65e46f4` (`App.tsx` +42/−, new
      `App.hotkeys.test.tsx` +102); `src-tauri/tauri.conf.json:16-17` is
      `1200×800` (verified 2026-10-12). NOT verified: the html §10 size
      comparison (visual, superseded by later audit 60/61 passes).
- [x] T7 Composer polish → `Composer.tsx`/test, `ModelPicker.tsx`/test.
      Icon toggles (memory/effort/web/think) with tooltips, effort = thinking
      level indicator, model chip, token hint, keep slash/keys/stop.
      (Issue 7) — Composer half in `65e46f4`; **the `ModelPicker` half landed
      2026-10-13**: the compact trigger is now the reference's `.ctools .chip`
      (`ModelPicker.tsx:231` `data-testid="model-chip"`, `h-7` + `border-border` +
      `bg-card` + `text-xs` + `max-w-[260px]`; `:244` the label truncates at
      `model-chip-label`). The chevron is `SelectTrigger`'s own, so exactly one
      renders — no duplication. Applies in `compact` mode only: the Settings →
      Models picker (`data-testid="model-picker"`) keeps its full-width shape.
      Red-first at `ModelPicker.test.tsx:94`; `ModelPicker` + `Composer` suites
      80/80 after. **Still open from T8:** the visual side-by-side against the
      reference (the chip's appearance is asserted structurally here, not seen).
- [ ] T8 Verify (sequential, after T1–T7): capture every screen vs html,
      full gates, report. NOT parallel. — **NOT RUN**: only the T5 capture
      exists (1 of the required per-screen set); T8 also depends on T7.
      Full gates (tsc/eslint/test/cargo) were re-established by the
      2026-10-12 review closeout instead, but the side-by-side visual
      comparison remains outstanding.

## Acceptance criteria

- [ ] Side-by-side captures per screen in `.openchamber/screenshots/` — **NOT DONE**: only
      `031-t5-working-thread.png` exists; T8 never ran (see above).
- [ ] `tsc` + `eslint` clean, full suite green — re-verified by the 2026-10-12 closeout gate
      runs (per-component evidence in the audit reports); final full-suite sign-off is the
      closeout's own gate run, not this task's.
- [ ] No `any`, no console.log, zero static `@/mock` in real code — covered by the same
      closeout gate runs; not separately re-verified here.
- [ ] Tooling notes: `browser.snapshot` wedges on React pages (use capture+read);
      html page snapshots fine; kill stray servers you start
