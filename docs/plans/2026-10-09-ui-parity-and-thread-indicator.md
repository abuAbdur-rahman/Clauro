# UI Parity Plan — prototype ↔ repo, merged SPEC, thread status indicator

**Date:** 2026-10-09
**Status:** approved — target = **both** (repo `src/` + prototype `index.html`), SPEC authority = **merge**, indicator semantics = as proposed.
**Inputs:** 10-domain subagent audit of `C:\Users\abdul\Downloads\index.html` vs `D:\oss\Clauro\src`, against `C:\Users\abdul\Downloads\SUPER_PROMPT_SHADCN.md` and repo `SPEC.md` / `UI-GUIDE.md`.

---

## 0. Ground rules (from AGENTS.md — non-negotiable)

- **SDD:** every code change lands behind a task in `Tasks/` (next: `029`, `030`, `031`) and a D-number in `DECISIONS.md` where a design choice is made.
- **TDD:** failing test first, in the same commit as the code. Test must fail for the right reason before the fix.
- Checks before "done": `pnpm typecheck`, `pnpm lint`, `pnpm test` (`vitest run`), `pnpm build`.
- Prototype (`C:\Users\abdul\Downloads\index.html`) stays single-file vanilla JS — fixes verified by rendering in a browser, no framework introduction.
- No features outside the merged SPEC. No new dependencies beyond sonner/cmdk if approved below.
- Verdicts marked **§8a Windows-only** require Windows verification before the word "verified" is used.

---

## P0 — Decisions (no code; gates rows 8, 16, 18)

| # | Decision | Resolution | Action |
|---|---|---|---|
| D1 | Two SPECs conflict: SUPER_PROMPT §8 cites "SPEC section 16" (exists only in Downloads SPEC:355); repo SPEC ends at §6 | **Merge** — union DoD: all-8-settings-pages, onboarding, full shortcut set, sidebar date groups, accent/font-size persistence, artifact Preview/Code tabs are IN scope | Add `DECISIONS.md` **D116** (merged SPEC authority, reason: 2026-10-09 user decision) |
| D2 | Artifact tabs/copy/download: SUPER_PROMPT §3 wants them, repo SPEC:153 defers to v2 | **Merge** — pulled forward into v1 | Cover in **D116** (or separate D117 if preferred) |
| D3 | New dependency for palette/toasts: cmdk + sonner (SUPER_PROMPT §1 list) | Approve both — already on the approved list in SUPER_PROMPT §6 | Add `TECH_STACK.md` §6 line citing SUPER_PROMPT §1 |

---

## P1 — repo Criticals

| # | Fix | Target | Sev | Verify (test-first) |
|---|---|---|---|---|
| 1 | Palette trap: add `onOpenChange` + real `onAction` (or migrate to cmdk `CommandDialog`) | `src/features/shell/CommandPalette.tsx`, `src/app/App.tsx` | Critical | test: Esc closes; Enter runs action |
| 2 | `DeleteConfirm` undismissable: cancel path + promise helper via alert-dialog | `src/features/retention/DeleteConfirm.tsx` | Critical | test: Esc/Cancel → resolves `false` |
| 3 | Home composer dead: route `onSend` → `createThread()` + open chat | `src/app/App.tsx:144` | Critical | test: send creates thread, navigates |
| 4 | Custom titlebar: `decorations:false` + `TitleBar.tsx` (32px, drag region, 46×32 caption buttons, close hover `#C42B1C`, Tauri min/max/close) | `src-tauri/tauri.conf.json`, `src/app/TitleBar.tsx` (new) | Critical | unit: render + aria-labels; **§8a Windows-only** visual |
| 5 | Sidebar persistence: cookie (7-day) → localStorage try/catch wrapper | `src/components/ui/sidebar.tsx:78` | Important | test: toggle → localStorage key; state survives remount |

## P2 — repo feature gaps (prototype = reference implementation)

| # | Fix | Target | Sev | Verify |
|---|---|---|---|---|
| 6 | Shortcuts 2/8 → all: Ctrl+N / Ctrl+, / Ctrl+B / Ctrl+Shift+A / Ctrl+Shift+C / F11 / Ctrl+B·I·E (composer); drop `metaKey`; one `lib/shortcuts.ts` hook | `src/features/shell/hotkey.ts` + composer | Important | test each binding |
| 7 | **Thread status indicator** — see spec below | sidebar rail + thread store | Important | test 4 states + viewed-on-open |
| 8 | Settings 3/8 pages → all 8 + search box (nav+content filter, row highlight; port proto 672, 547–551 logic) | `src/features/settings/SettingsDialog.tsx` | Important | per-page render + search tests (D116) |
| 9 | Context bar: 70/90% thresholds + Compact, fed from real `usage` in `turn.ts` (NEITHER gap — no truthful impl exists anywhere) | `ChatView.tsx` + `ui/progress` | Important | threshold tests |
| 10 | Message actions row: copy / regenerate (**append, never pop** — D19) / branch / thumbs → `MessageFooter` | `src/features/transcript/TranscriptView.tsx` | Important | action tests, append-only preserved |
| 11 | Scroll-follow 48px + "Jump to latest"; wire already-tested `FrameCoalescer` into stream path | `src/features/turn/ChatView.tsx`, `markdown.ts:91` | Important | stream test |
| 12 | Composer suite: slash menu, Ctrl+B/I/E, token hint, `sendWith` + `isComposing` guard, send→stop in-place swap, unbounded textarea cap (`max-h-[40vh]`) | `src/components/Composer.tsx` | Important | Composer tests |
| 13 | Accent swatches (6 presets) + font-size slider wired to `data-accent`/`--fs`; kill `"neutral"` hardcode | `src/features/shell/usetheme.ts:42`, `styles.css`, AppearancePane | Important | persistence test |
| 14 | Reduced-motion block + artifact overlay as `Sheet` under 1100px + 900px min width | `styles.css`, `src/app/App.tsx` | Important | media-query/CSS check |
| 15 | Toasts: add sonner (D3), `<Toaster position="bottom-center">`, replace dead-end feedback | root + call sites | Important | manual + render test |
| 16 | Onboarding: 4-step flow (proto 568–577 reference; D116 puts it in scope) | `src/features/onboarding/` (new) | Important | e2e first-run |
| 17 | Projects: wire `noop` handlers — store CRUD, NewProjectDialog, editable title, instructions textarea + Save, `auto-fill` grid, desc+count search, empty state | `App.tsx:177,186-188`, `ProjectsGrid/Detail.tsx` | Important | existing + new tests |
| 18 | Artifact producer: persist `source` by id, `setCompiling`, clickable card → drawer, header w/ version, `w-[420px]` (D116: tabs in scope) | `App.tsx:224`, `TranscriptView.tsx:154`, `ArtifactDrawer.tsx` | Important | phase3 e2e extended |
| 19 | Sidebar rows: `groupChats` date buckets + pin/rename/move submenu via vendored `dropdown-menu` (currently orphaned) | `ProjectsRail.tsx` | Important | port proto `groupChats` (370) + tests |

## P3 — hygiene

| # | Fix | Target | Sev |
|---|---|---|---|
| 20 | Kill `neutral-*` hardcodes → tokens (`UserRow`, `ArtifactDrawer`, `App.tsx:106`) | several | Important |
| 21 | Rule-4 one-line reason on 6 non-shadcn `ui/` files (`bubble,message,marker,attachment,empty,spinner`) or relocate them | `src/components/ui/` | Nit |
| 22 | `esc()` add `'`; markdown `a` color + code wrap rules | `styles.css` (+ prototype 339/377) | Nit |

## P4 — prototype-only fixes (`C:\Users\abdul\Downloads\index.html`, stays vanilla single-file)

| # | Fix | Sev |
|---|---|---|
| 23 | Dead `groupDates` toggle (357/535 never read by 370) — wire or drop | Important |
| 24 | `pd.save` validation: name + URL required; reset `status` → `untested` on key/type change (631–633) | Critical |
| 25 | Timer registry: compaction/test/onboarding timers tracked + cleared on view switch (487, 624, 630, 652) | Important |
| 26 | `edit.save` guard `$('#editTa')?.value` (599); mixed clock `greeting()` → `S.now` (368) | Important |
| 27 | Honesty pass: hardcoded `v1` badge, `42%`, `2.4MB` → computed or labeled sample; fake `401` copy → "simulated" | Important |
| 28 | Edit-resubmit: keep append-only (599 truncation violates D19 — append corrected turn instead) | Important |
| 29 | Thread status indicator mirrored in prototype sidebar (same 4-state spec) | Important |

---

## Thread status indicator — spec (confirmed)

Mirrors engine state on each sidebar thread row:

| State | Meaning | Signal source (repo / prototype) | Look |
|---|---|---|---|
| `working` | streaming or compacting now | thread store `streaming`/`compacting` / `S.streamChat`, `S.compacting` | pulsing dot or `ui/spinner`; replaces relative-time text |
| `done` | reply finished since last view | `turn-done` newer than `lastReadAt` / `S.replyCount` vs per-chat read mark | accent dot + bold title |
| `not viewed` | unread activity; `openChat` marks viewed | `lastReadAt < updatedAt` / per-chat `readAt` | hollow/muted dot |
| idle | read, no new activity | else | unchanged "N days ago" text |

- `viewed` marked on thread select (`openChat` / thread switch).
- `lastReadAt` persisted (repo: SQLite thread row; prototype: in-state, consistent with its localStorage rules).
- Scope: **sidebar rows only** (titlebar unchanged).

---

## Execution order

1. **P0** (D116 + D3/TECH_STACK lines) — gates rows 8, 16, 18.
2. **P1** rows 1–5 — repo boots correctly.
3. **P2** rows 6–19 — parallelizable by disjoint file sets; row 7 (indicator) after thread store fields exist.
4. **P3** hygiene, any time.
5. **P4** prototype rows 23–29 — independent, can run parallel with 2–3.
6. Final gate: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, prototype render smoke-test (no console errors), §8a Windows-only visual pass for titlebar.

## Definition of done

- All P0–P4 rows ticked with `path:line` evidence (§7a closeout, same commit as code).
- Merged SPEC DoD (D116) items verifiable from source all pass; conflicts resolved, none silently dropped.
- No app logic in `components/ui/`; every custom-where-shadcn-could-go component carries a rule-4 reason.
- Prototype remains one file, renders clean, all 10 `Placeholder:` toasts still honest (keep-as-intentional list unchanged).
