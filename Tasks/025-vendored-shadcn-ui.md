# Task 025 — Vendored shadcn UI, app-shell only

**Phase** 5 · **Depends** `024` · **Decisions** D112 (shadcn half)
**Contracts** none — no shape changes; `ModelPicker` behaviour unchanged

**Status: implemented 2026-10-06 on Windows.** `tsc --noEmit` clean,
`eslint strictTypeChecked` clean, `vitest` 13 files / 100 tests green
(95 pre-existing untouched + 5 new `ModelPicker.test.tsx`).
`pnpm build` (`tsc && vite build`) green — the `@/*` alias resolves in
typecheck, tests, and the bundle.

## Failing test first

- `src/components/ModelPicker.test.tsx` written against the shadcn `Select`
  before the rewrite: 3 failed with `Unable to find role "combobox"` against
  the old `<ul>` list (the right failure — wrong primitive, not wrong logic);
  the 2 state tests (absent/stale) passed throughout. After the rewrite: 5/5.
- Full suite stayed green at every step except the new file — nothing else
  renders the picker.

## Do

**Copy, not a package (D112).** shadcn is Radix primitives plus
`cva`/`clsx`/`tailwind-merge` pasted into `src/components/ui/` — vendoring
*is* the install, and tweaking is the point. Four lint fixes versus upstream
(`no-confusing-void-expression` ×4, `restrict-template-expressions` ×1);
no behaviour change in any of them.

**Vendored:** `button`, `dialog` (+ `sheet`, the Sidebar mobile half),
`input`, `label`, `select`, `separator`, `sidebar`, `skeleton`, `tooltip`;
`src/lib/utils.ts` (`cn()`); `src/hooks/use-mobile.ts` (Sidebar breakpoint);
`components.json` (`new-york`, neutral, `@/*` aliases, lucide);
Tailwind v4 theme tokens in `src/styles.css` (`@theme inline` + `.dark`
variant, `tw-animate-css`).

**App-shell only, like `lucide-react` (D96).** Nothing Radix ever enters the
artifact frame (`D2`, `D3`, `D83`). `ArtifactDrawer.tsx` DOM is deliberately
untouched — its tests pin `aside`/`w-0`/sandbox tokens.

**Wired now:** `ModelPicker` → `Select` with provider `SelectGroup`s and
limits in each option label; unknown values degrade to the same typed notice.
**Wired later, by owner:** projects rail → `Sidebar` (`018`), `bash` approval
→ `Dialog` (`012`, `020` — approval is never a palette action), palette
shell → `Dialog` (`020`; `cmdk` stays recorded until `020` decides).

## Acceptance criteria

- [x] All shadcn deps pinned with licence + rejected alternative —
      `TECH_STACK.md` §7.1, `docs/dependencies.md` §7, this commit
- [x] Picker on `Select`: placeholder, grouped options with limits, choice
      writes thread state, thread stays open — `ModelPicker.test.tsx:32-97`
- [x] Offline/stale states unchanged — `ModelPicker.test.tsx:99-109`
- [x] Drawer DOM untouched, sandbox assertions hold —
      full suite 100/100, `ArtifactDrawer.test.tsx` unedited
- [x] `@/*` alias resolves in tsc, vitest, and vite build — `pnpm build` green
- [x] `TECH_STACK.md` §1 UI row, `DESIGN.md` §2, `ARCHITECTURE.md` §1 name
      the shadcn layer — same commit
