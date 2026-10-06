# Task 027 — Composer shell (textarea + footer actions)

**Phase** 5 · **Depends** `025`, `026` · **Decisions** D112
**Contracts** none — intent collection only; dispatch belongs to `023`

**Status: implemented 2026-10-06 on Windows.** `tsc` clean,
`eslint strictTypeChecked` clean, `vitest` 15 files / 111 tests green
(106 pre-existing + 5 new `Composer.test.tsx`).

## Failing test first

- `src/components/Composer.test.tsx` written before `Composer.tsx`: suite
  failed resolving `./Composer` (the right failure). After: 5/5.
- One `channel.test.ts` failure under full-suite parallel load during this
  task; 10/10 in isolation and 111/111 on re-run — timing flake, not a
  regression (file untouched, `git status` clean).

## Do

**Claude-like rows, not generic chat.** Assistant turns render `ghost`
(full-width, unframed markdown — shots 03/05); user turns render
`align="end"` bubbles (shots 04/07). Thinking is one collapsed inline
region (`D54`), never a side pane. Recorded in `DESIGN.md` §2.2.

**Footer carries the `+` menu contents (DESIGN.md §2.5):** attach (`Plus`,
`onAttach` — copies into the workspace, `D47`), memory toggle (locks after
first send, `D9`; controlled prop, `008`/`018` own the source), effort
`Select` (low/medium/high → `setEffort`, request params only, `D76`),
provider-grouped model picker (`ModelPicker compact` — new optional prop,
full-width default untouched), send (`ArrowUp`, disabled on empty,
Enter-to-send, Shift+Enter newline).

**Deliberately absent:** Chat|Cowork mode switch (not our product — no
second mode exists to switch to); voice renders **disabled with its reason**
(`No voice — not ours`, `DESIGN.md` §6), never a dead button. `bash`
approval is never a composer action (`D66`).

## Acceptance criteria

- [x] Empty draft disables send; send calls `onSend(text)` and clears —
      `Composer.test.tsx:32-45`
- [x] Attach/memory callbacks fire — `Composer.test.tsx:47-66`
- [x] Effort writes thread effort, model untouched — `Composer.test.tsx:68-79`
- [x] Provider-grouped picker embedded — `Composer.test.tsx:81-87`
- [x] Voice disabled, never sends — `Composer.test.tsx:89-101`
- [x] Full suite 111/111, lint + typecheck clean — 2026-10-06
