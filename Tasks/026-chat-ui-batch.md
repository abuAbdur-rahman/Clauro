# Task 026 — Chat UI batch (presentational primitives)

**Phase** 5 · **Depends** `025` · **Decisions** D112
**Contracts** none — no shapes; primitives render documented slots

**Status: implemented 2026-10-06 on Windows.** `tsc` clean,
`eslint strictTypeChecked` clean, `vitest` 14 files / 106 tests green
(100 pre-existing untouched + 6 new `ui-chat.test.tsx`).

## Failing test first

- `src/components/ui/ui-chat.test.tsx` written before the batch: every suite
  failed to resolve its primitive (the right failure — missing files, not
  wrong logic). After vendoring: 6/6. Two test-markup fixes during green
  (`role="status"` duplication, both mine, not the primitives').

## Do

**Vendored to the documented shadcn API** (`ui.shadcn.com`, Radix track,
fetched 2026-10-06): `message` (+`MessageGroup`), `bubble` (+variants,
`BubbleGroup`, `BubbleReactions`), `avatar`, `attachment` (+states, sizes,
`AttachmentGroup`, `AttachmentTrigger`), `alert`, `badge`, `card`,
`dropdown-menu`, `scroll-area`, `progress`, `empty`, `textarea`, `spinner`,
`marker`. Same `data-slot` API as upstream, so a future CLI pass can adopt
the files without rewiring callers.

**Two deliberate divergences, both recorded:**

1. `message-scroller` behaviour **not vendored**. Its follow-output lives in
   the `@shadcn/react` headless package — a new non-Radix dependency that
   needs its own vetting (`AGENTS.md` §5a) and its owner is the transcript
   loop (`006`), which does not exist yet. Presentational row layout
   (`Message`) is here; scroll behaviour lands with the loop.
2. `AttachmentAction` defaults to `size="icon"` (upstream says `icon-xs`,
   which our `button.tsx` does not define). No new button size invented for
   one caller.

**New npm deps (all MIT, Radix line):** `avatar 1.1.20` · `dropdown-menu
2.1.16` · `scroll-area 1.2.18` · `progress 1.2.20`. Pinned in `TECH_STACK.md`
§7.1, recorded in `docs/dependencies.md` §7.

## Acceptance criteria

- [x] All 15 primitives render documented slots — `ui-chat.test.tsx:24-138`
- [x] New deps pinned with licence + rejected alternative — §7.1, §7, commit
- [x] Full suite 106/106, lint + typecheck clean — 2026-10-06
- [x] Scroller deferral recorded with owner — this file + `PHASES.md`
