# Task 024 — Feature-based frontend layout

**Phase** 5 · **Depends** `002` · **Decisions** D112 (layout half)
**Contracts** none — pure move, no shape changes

**Status: implemented 2026-10-06 on Windows.** `tsc --noEmit` clean, `eslint` clean,
`vitest` 12 files / 95 tests green with zero test edits (only import paths and one
`vi.mock` path). No behaviour change by construction: every diff hunk is a rename,
a barrel, or an import path.

## Failing test first

- The suite itself: after `git mv`, every suite importing a moved module fails to
  resolve until its import path is updated — the resolver is the test.
- `tsc --noEmit` clean (strict, `noUnusedLocals` — a dropped export breaks the barrel).
- `vitest` 95/95 green, same count as before the move.

## Do

**Feature-based, lowercase + barrel.** `src/features/<name>/` owns logic and colocated
tests; `src/components/` owns shared UI; `src/app/` owns the shell entry; `src/lib/`
is reserved for `utils.ts` (lands with 025). **D112.**

```
src/
  app/App.tsx (+ skeleton.test.ts)
  components/ArtifactDrawer.tsx (+ test), ModelPicker.tsx
  features/
    artifact/{store.ts (+ test), prepare.ts (+ test), compile.ts (+ test),
      compile.transform.ts, compile.worker.ts, channel.ts (+ test),
      envelope.ts (+ test), sanitize.ts (+ test), wrap.ts,
      frame-runtime.js (+ test), index.ts}
    catalogue/{catalogue.ts (+ test), models.ts (+ test), thread.ts (+ test),
      index.ts}
  main.tsx · styles.css · vite-env.d.ts (unchanged)
```

`frame-runtime.js` stays raw-text-shipped, never bundled — the barrel does not
re-export it. `tsconfig.json` / `eslint.config.js` comments updated to the new path.
Closed-task path citations (`013`, `014`, `001`, `006`) are historical evidence and
are deliberately not rewritten.

## Acceptance criteria

- [x] Every module resolves from its new path — `tsc` clean, `src/features/artifact/index.ts:1`
      and `src/features/catalogue/index.ts:1` barrels re-export all public symbols
- [x] All 95 tests pass with no test-logic edits — `pnpm test`, 12 files green 2026-10-06
- [x] No behaviour change — `git status` shows renames (`R`) plus two new barrels plus
      import-path edits only
- [x] `TECH_STACK.md` §2 workspace layout names the feature directories — same commit
