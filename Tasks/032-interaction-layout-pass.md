# Task 032 — Interaction + layout pass (shortcuts, dead buttons, chat dock)

**Phase** 6 · **Depends** `031` · **Decisions** D112
**Contracts** none — behavior/visual only

**Brief (Operate):** html truth `docs/references/ui/index.html`
(image-1 = floating composer + context bar + actions; image-2 = current gaps).
Impeccable floor: every button acts or is disabled-with-reason; kbd chips;
sticky regions; contrast; focus.

**Status: open.** 4 thread-safe groups (disjoint files):

- [x] U1 Menu + shortcuts → DONE in-tree (Shortcuts enabled → shortcuts settings page; kbd table live-verified). (Issues 1, 2)
- [x] U2 Shell actions audit → `App.tsx` + tests. DONE (landed in-tree with
      App.actions.test.tsx; committed 4aa3359): fresh thread per New chat,
      memory state, project dialog + creation, project Start-chat staging.
      Live-verified send/stream; full App suites green in isolation.
      (Issue 3)
- [x] U3 Chat dock → `ChatView.tsx` + test. DONE + proven live (composer
      docked, transcript owns the only scroller, context bar, jump icon):
      column h-full flex-col, transcript flex-1 overflow-y-auto, footer
      shrink-0; Jump = lucide ArrowDown; debug line removed; boot errors on
      skeleton via role=alert. Composer attach was already an honest notice.
      (Issues 3-partial, 5-critical)
- [x] U4 Page frames → DONE in-tree (borders/margins/cards/detail rhythm live-verified on project detail). (Issue 4)

## Acceptance criteria

- [x] Live captures: shortcuts page, new-chat creates+opens, docked composer
      with scrolled transcript, project frames, transcript code header
      (js + Copy), token hints without ≈
- [x] `tsc` + `eslint` clean, full suite green (50 files / 489 tests)
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
