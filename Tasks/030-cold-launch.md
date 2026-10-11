# Task 030 — Cold launch: measure, skeleton, split, pre-bundle

**Phase** 6 · **Depends** `029` · **Decisions** D112 (skeleton/spinner primitives)
**Contracts** none — shell-only, no wire shapes change

**Status: landed.** `tsc` + `eslint` clean, `src/app` 7 files / 27 tests green
(incl. new `App.boot.test.tsx`).

## Measured (this box, Windows, loaded)

| Phase | Before | After | Notes |
|---|---|---|---|
| Server ready | 0.8s | 0.8s | never the problem |
| First index hit (cold cache) | — | 24s | queues behind optimizer |
| `App.tsx` first transform | 39.8s | 1s warm | pre-bundle + smaller graph |
| `styles.css` | 4.2s (0.2s warm) | 0.2s warm | 220s outlier was contention, not file cost |
| Virgin-cache esbuild optimize | ~4 min | ~4 min | environmental (see below) |
| Steady-state first paint | minutes | ~1s | cache + split |

Method: timed `Invoke-WebRequest` per module, cold (`node_modules/.vite`
deleted) vs warm. Outliers re-run on quiet box before quoting.

## Do (done)

1. `vite.config.ts` — `optimizeDeps.include` pins the stable heavy graph
   (react, radix ×11, lucide-react, marked, dompurify, zod, …) to ONE startup
   bundle instead of repeated on-demand re-optimizes. `sucrase` deliberately
   OUT (artifact-lazy route only; D4 owner decides on dynamic import).
2. `vite.config.ts` — `server.warmup.clientFiles` transforms
   `main.tsx` + `App.tsx` + `styles.css` at ready, not at first paint.
3. `App.tsx` — non-home views lazy (`ChatView`, `ProvidersView`,
   `ProjectsGrid`, `ProjectDetail`, `CommandPalette`, `SettingsDialog`,
   `ArtifactDrawer`) with skeleton (`ViewSkeleton`) or null (closed overlays)
   fallbacks. First-paint graph = shell only.
4. `App.tsx` — boot `checking` renders `BootSkeleton` (titlebar/rail/home
   shape + sr-only status text) instead of a bare line; idle-time preload of
   chat + settings chunks via `requestIdleCallback`.
5. Interaction-heavy tests keep explicit 30s timeouts (from 029 wave).

## Acceptance criteria

- [x] Cold first paint dominated by ONE optimizer pass, never repeated re-optimizes
- [x] Warm first paint ~1s (App.tsx 39.8s → 1s)
- [x] Boot splash is layout-shaped skeleton with `boot-skeleton` testid
- [x] `tsc`, eslint, `src/app` green
- [ ] Remaining environmental item below (needs human, not code)

## NOT fixed by code (environmental, for the human)

Virgin-cache esbuild still takes minutes on this box. Prime suspect:
Windows Defender real-time scanning on thousands of `lucide-react`/radix
module files during bundling. Proposed fix (human action):
`Add-MpPreference -ExclusionPath D:\oss\Clauro\node_modules` (and the pnpm
store). Expected effect: cold optimize minutes → seconds. Verify by
re-running the cold timing above after excluding.
Second: `pnpm tauri dev` production binary is unaffected (prebuilt `dist`,
no optimizer) — if the 2–5 min complaint is about the PACKAGED app, say so;
that is a different investigation (WebView2 boot / SQLite / keyring).
