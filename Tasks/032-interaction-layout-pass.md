# Task 032 — Interaction + layout pass (shortcuts, dead buttons, chat dock)

**Phase** 6 · **Depends** `031` · **Decisions** D112
**Contracts** none — behavior/visual only

**Brief (Operate):** html truth `docs/references/ui/index.html`
(image-1 = floating composer + context bar + actions; image-2 = current gaps).
Impeccable floor: every button acts or is disabled-with-reason; kbd chips;
sticky regions; contrast; focus.

**Status: landed.** All four groups are done and the three acceptance criteria below are ticked.
(Review 41 found this file saying "Status: open" while every box was ticked, and citing a commit
`4aa3359` whose stat does not contain `App.actions.test.tsx`. Both corrected 2026-10-12: the
test file was added by **`2614043`** — `git log --follow -- src/app/App.actions.test.tsx` returns
that single commit. The remaining uncommitted item is the follow-up section at the bottom of this
file, not the four groups.)

- [x] U1 Menu + shortcuts → DONE in-tree (Shortcuts enabled → shortcuts settings page; kbd table
      live-verified). Evidence: `SettingsDialog.test.tsx:209` (shortcuts page + about names the
      app), `SettingsDialog.test.tsx:222` (every row renders with split kbd chips —
      "Ctrl+Shift+C" asserted as three `kbd` elements at `:232-241`). (Issues 1, 2)
- [x] U2 Shell actions audit → `App.tsx` + tests. DONE (landed in-tree with
      `src/app/App.actions.test.tsx`, added by commit **`2614043`** — the earlier
      `4aa3359` attribution was wrong): fresh thread per New chat,
      memory state, project dialog + creation, project Start-chat staging.
      Live-verified send/stream; full App suites green in isolation. Evidence:
      `App.actions.test.tsx:54` (the `032 U2` suite) with cases at `:62` (rail New chat creates +
      opens), `:76` (memory toggle flips composer memory state), `:85` (New project dialog creates
      a card), `:98` (project Start-chat stages the message). (Issue 3)
- [x] U3 Chat dock → `ChatView.tsx` + test. DONE + proven live (composer
      docked, transcript owns the only scroller, context bar, jump icon):
      column h-full flex-col, transcript flex-1 overflow-y-auto, footer
      shrink-0; Jump = lucide ArrowDown; debug line removed; boot errors on
      skeleton via role=alert. Composer attach was already an honest notice.
      Evidence: `ChatView.test.tsx:395` ("docks the composer: the transcript owns the only
      scroller", composer asserted outside the scroller at `:416-418`), `:422` (context bar with an
      honest estimate once rows exist), `:443` (context bar hidden when the transcript is empty),
      `:538` ("offers Jump to latest instead of yanking when scrolled up", click at `:591`).
      (Issues 3-partial, 5-critical)
- [x] U4 Page frames → DONE in-tree (borders/margins/cards/detail rhythm live-verified on project
      detail). Evidence: `ProjectDetail.test.tsx:147` (page frame wraps the two-column rhythm,
      `1fr 320px` / 20px gap, asserted via `.page-frame` at `:151`), `:154` (h3 heading rhythm),
      `:161` (side panels carry the 1px card frame), `:170` (chat rows carry the bordered row
      rhythm), `:177` (empty state is a framed panel), `:184` (composer box uses the border token).
      (Issue 4)

## Acceptance criteria

- [x] Live captures: shortcuts page, new-chat creates+opens, docked composer
      with scrolled transcript, project frames, transcript code header
      (js + Copy), token hints without ≈
- [x] `tsc` + `eslint` clean, full suite green (50 files / 489 tests — as counted at commit time;
      `Tasks/033` records 473 on 2026-10-11 from a later, differently-scoped run. The two counts
      are from different snapshots, not a contradiction; an exact recount is owed to whoever
      next runs the suite, and neither number is load-bearing for a gate)
- [x] Impeccable verify pass on the diff before commit (states, contrast,
      kbd, no dead buttons) — main thread runs it

## Follow-up (uncommitted): composer code fences + token honesty

- Token hints + context bar drop the ≈ sign (word "estimate" stays).
- Composer focus ring wraps the whole input section (`focus-within`).
- Ordered lists verified rendering (new markdown test).
- Transcript code blocks gain header (language label + Copy, idempotent,
  plaintext — no highlighter vendored per research).
- Composer fence input per research spec (` ```lang` + Enter opens block,
  no double-close, Enter/Shift+Enter newline inside, Ctrl+Enter sends,
  Tab indents, paste wraps, invalid lang sends literally). 8 new tests.
- Research note: Claude/ChatGPT do no fence autocomplete; editor-grade
  (Lexical-style) behavior implemented instead. highlight.js only if color
  is later justified (record in TECH_STACK.md §6 first).
