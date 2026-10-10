# Task 029 — Dual-mode shell parity (real `tauri dev` + mock `dev:mock`)

**Phase** 6 · **Depends** `025`, `028` · **Decisions** D2/D3/D6/D116-plan/D123/D124
**Contracts** none new — intent + seed port; dispatch stays with owners (023 turn, 004 store)

**Status: slice 1 landed 2026-10-10 on Windows.** `tsc` clean, `eslint` clean,
full `vitest` 40 files / 268 green (incl. 3 new suites). `dev:mock` boots
(`VITE mock ready`, 1430 verified). Real imports zero `@/mock/*`.
(1420, Rust, 100% real, fail loudly per `docs/blockers.md`); mock = `pnpm dev:mock`
(1430, web-only, enriched `mock-tauri.ts` + TS SEED). Visual truth =
`docs/references/ui/index.html`.

## Failing test first

- `src/mock/seed.test.ts`: asserts SEED port fidelity (11 chats, 3 providers,
  5 memories, 3 projects, `defaultModel p2:claude-sonnet`, `groupChats` buckets
  non-empty). Must fail resolving `@/mock/seed` before impl.
- `src/features/projects/ProjectsRail.indicator.test.tsx`: asserts 4-state
  thread indicator (`working | done | not-viewed | idle`), `viewed-on-open`
  marks read, `data-testid` present on rows. Must fail (no `status` prop) first.
- `src/app/shell.mockmode.test.ts`: asserts `import.meta.env.MODE !== "mock"`
  path never touches mock seed in real boot (real imports no `@/mock/*`).
  Fails if real imports mock.

## Do

**Dual serve (no second Tauri config):**
`dev:mock = vite --mode mock --port 1430 --strictPort`; `vite.config.ts` treats
`mode === "mock"` like `browser` (Tauri API alias → `mock-tauri.ts`).
`tauri dev` untouched (1420, real).

**Mock data (TS port, index.html SEED verbatim):** `src/mock/seed.ts` —
`SEED.now/users/providers/modelMeta/defaultModel/memories/projects/chats/
suggestions/replies/PT/FAKE/CMDS/PAGES/ACC/KEYS/PCOL` + `groupChats()` pure +
`mockReply()` timer engine (typing 700ms → word stream 25ms, deterministic under
fake timers). No Rust calls; `mock-tauri.ts` serves seed via existing commands
(`provider_list`, `transcript_read` per-thread, `turn_start` fake stream).

**Shell fixes (both modes, B01–B05/B11 slice):**
sidebar stretches to window height (kill hang: wrapper `self-stretch`,
rail `h-full min-h-0`, no padding-induced shortfall); rail width 56px
(`w-14`); collapse → localStorage try/catch; drop `metaKey`; thread rows get
`ThreadStatus` dot + `data-testid="thread-row-{id}"` + `data-status`.

**Indicator spec (confirmed):** `working` = streaming/compacting (pulse/spinner,
replaces time); `done` = `turn-done` newer than `lastReadAt` (accent dot + bold);
`not-viewed` = `lastReadAt < updatedAt` (hollow dot); idle = time text.
Viewed marked on select. `lastReadAt` persisted (SQLite real; in-state mock).

**Testability:** every interactive node `data-testid`; mock timers use
`vi.useFakeTimers` deterministic; `?seed=1` forces seed reset (human + agent
smoke list in this file on close).

**Artifact rule (D123/D124):** mock mirrors host path — `artifact_publish`
→ URL, same sandbox/CSP/nav-guard. No `srcdoc` shortcut.

## Acceptance criteria

- [x] `pnpm dev:mock` boots on 1430 with mock alias; `pnpm tauri dev` on 1420 untouched (config-only, no Tauri change)
- [x] Sidebar full window height, 56px rail (`ProjectsRail.tsx:84`, `App.tsx:107-111`) — §8a visual pass still pending
- [x] Indicator 4 states render + viewed-on-open click; tests green (`ProjectsRail.indicator.test.tsx`)
- [x] Real imports zero `@/mock/*` (`shell.mockmode.test.ts`)
- [x] `tsc`, eslint, full vitest green; `docs/blockers.md` B02/B11 ticked with `path:line`


## Follow-up slices

- [x] mock-tauri.ts SEED serving + bare-shell reset (mock-tauri.seed.test.ts 6/6, deterministic)
- [x] lastReadAt/running store + localStorage collapse + drop metaKey (thread +10, hotkey, sidebar.persistence tests)
- [x] Titlebar B01 (TitleBar.tsx + test, decorations:false) + App wiring (statusByThread, viewed-on-open)
- [x] Mock seed bootstrap: rail/grid/detail mirror html SEED in mock mode only (seedToRail, mockDetailProps, parseSeedSize; dynamic import keeps real bundle + source mock-free)
- [x] Interaction-heavy tests get explicit 30s timeouts (parallel-load flakes, green in isolation)
- [ ] E2E pass on dev:mock via browser smoke list — in progress
- [ ] Remaining blockers per docs/blockers.md