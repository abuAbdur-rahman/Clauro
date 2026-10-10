# SUPER PROMPT (shadcn edition) — Clauro BYOK Chat

Read `SPEC.md` first. It defines **what** Clauro does (screens, data, flows, shortcuts, acceptance list). This file changes **how** it is built. Where the two conflict, **this file wins**. Product name is **Clauro** (keep it in one `APP_NAME` constant).

## 0. What changes vs SPEC.md

| SPEC.md rule | Replaced by |
|---|---|
| Single `index.html`, no frameworks | Vite + React + TypeScript + Tailwind + **shadcn/ui** project |
| Hand-written `menu`, `modal`, `toast`, toggle, tabs | shadcn components (map in section 3) |
| Lucide via CDN | `lucide-react` |
| ~700 lines JS | No line cap. Keep files small and focused instead |
| Hand-written CSS tokens | shadcn CSS variables in `globals.css`, mapped from SPEC section 3.4 |

Unchanged: UI-only prototype, **no real API calls**, all data in one `SEED`, Windows look and feel, every shortcut, every acceptance item, localStorage only for theme / accent / font size / sidebar / onboarding flag / default model.

## 1. Stack and setup

```
Vite + React 18 + TypeScript, Tailwind, shadcn/ui (new-york style, CSS variables on)
lucide-react, sonner (toast), cmdk (via shadcn command)
State: one Zustand store (or useReducer + context). No backend, no router lib
```

Setup order: scaffold Vite -> init Tailwind -> `npx shadcn@latest init` -> `npx shadcn@latest add <components>` (list in section 3) -> build.
Do not hand-edit generated files in `components/ui/` except for theming (radius, sizes, colors). Wrap or compose instead.

## 2. Folder layout

```
src/
  components/
    ui/            <- shadcn only (generated). Do not put custom components here
    app/           <- Clauro components that compose shadcn pieces
      shell/       TitleBar, CaptionButtons, AppShell
      sidebar/     Sidebar, ChatList, ChatRow, ProfileMenu
      chat/        ChatView, MessageList, UserMessage, AssistantMessage, Composer, SlashMenu, ModelPicker, ContextBar, SummaryCard, Welcome
      panel/       ArtifactPanel, ArtifactCard
      settings/    SettingsDialog, pages/*, ProviderDialog, ProviderCard
      projects/    ProjectsGrid, ProjectDetail
      palette/     CommandPalette
      onboarding/  OnboardingDialog
    common/        Markdown, CodeBlock, ConfirmDialog, SettingRow, StatusPill, EmptyState
  data/seed.ts     SEED + fake reply engine data
  store/           app store
  lib/             utils, shortcuts, groupChats, estimateTokens
```

## 3. Component map: which shadcn component for what

Use **exactly** these unless section 4 says to build custom. Install only what is used.

| UI piece (SPEC ref) | shadcn component(s) | Notes |
|---|---|---|
| All buttons, send/stop, icon buttons | `button` (variants: default, ghost, outline, destructive; sizes `sm`, `icon`) | Accent = `primary` token |
| Caption buttons (3.1) | `button` ghost + custom class | Close hover red via class, 46x32 |
| Sidebar shell, collapse to icons (5) | `sidebar` (collapsible="icon") **or** custom (see 4) | Prefer custom if `sidebar` fights the 260/56px spec or the custom title bar |
| Chat row `...` menu, profile menu, message `...` | `dropdown-menu` | Pin, Rename, Move, Export, Delete |
| Right-click on chat row (optional) | `context-menu` | Skip if over budget |
| Rename inline | `input` | Enter saves, Esc cancels |
| Delete / Clear / Reset / confirm (12) | `alert-dialog` via `ConfirmDialog` | Promise-style helper wraps it |
| Settings overlay (7) | `dialog` (large) + `tabs` (vertical) or `sidebar` for nav | Search box = `input` |
| Settings rows | `label`, `input`, `textarea`, `select`, `switch`, `slider`, `radio-group`, `toggle-group` | Row wrapper = custom `SettingRow` |
| Theme tiles | `radio-group` styled as cards | Custom tiles on top of radio |
| Accent swatches | `toggle-group` (type single) | Swatch = custom styling |
| Density Comfortable/Compact | `toggle-group` | |
| Provider list cards | `card`, `badge` (status pill), `switch`, `button` | |
| Provider add/edit (7.3) | `dialog` + `form` (react-hook-form + zod) + `select` + `input` | Eye toggle = `button` in an input group |
| Model chips (add/remove) | `badge` + `button` icon | |
| Models table (7.4) | `table` + `switch` | |
| Parameters sliders | `slider` | |
| Memory list (7.6) | `card`, `textarea`, `button`, `switch`, `scroll-area` | |
| Data usage bar | `progress` | |
| Shortcuts table | `table` + `kbd` (custom if `kbd` not in registry) | |
| Model picker in composer (6.6.5) | `popover` + `command` | Search + groups + checkmark. Empty state = `empty`/custom |
| Slash menu (6.6.4) | `popover` + `command` anchored to textarea | See section 4 (caret anchoring is custom) |
| Command palette Ctrl+K (9) | `command` inside `dialog` (`CommandDialog`) | Groups: Actions, Chats, Projects, Settings |
| Context bar (6.5) | `progress` + `tooltip` + `button` | Color change at 70/90% via class |
| Toasts (12) | `sonner` | Undo / Save / Dismiss via `action` |
| Tooltips on collapsed sidebar and icon buttons | `tooltip` | Wrap app in `TooltipProvider` |
| Tabs in artifact panel (10) | `tabs` | Preview/Code, Doc/Source |
| Artifact panel container | custom (see 4); `resizable` optional | Overlay under 1100px = `sheet` (side right) |
| Artifact preview | plain `<iframe sandbox srcDoc>` | No allow-same-origin |
| Compacted summary (6.5) | `collapsible` + `card` | |
| Scrollable lists and message list | `scroll-area` | Needs custom stick-to-bottom logic (see 4) |
| Avatars (profile, assistant) | `avatar` | Initials fallback |
| Dividers | `separator` | |
| Loading states (fetch, test, compact) | `skeleton` / `spinner` (build a tiny spinner if missing) | |
| Empty states | `empty` if in registry, else custom `EmptyState` | |
| Onboarding (11) | `dialog` (full) + custom stepper | Stepper dots custom |
| Project cards (8) | `card` | |
| Project detail layout | `card`, `textarea`, `button`, `input` (file), `progress` | |
| Attachments chips | `badge` + button | |
| Web search / Thinking toggles | `toggle` | Cosmetic |
| Collapsible raw sections | `collapsible` | |
| Alerts / banners (e.g. "UI prototype") | `alert` | |

Before using any component not listed, check the shadcn registry first. If it exists and fits, use it.

## 4. Rule: when to build a new component instead

**Default: use shadcn.** Build a **new custom component** in `components/app/` or `components/common/` when any of these is true:

1. **No shadcn equivalent.** Examples: markdown renderer, streaming text with caret, typing dots, artifact card, summary card, context bar, chat grouping header, title bar with drag region.
2. **A shadcn component would need heavy overriding or hacks.** If you would fight its internals (forking its CSS, patching Radix behavior, working around its layout, or stacking more than ~3 workaround props), stop and write a purpose-built component. Compose Radix primitives or plain elements with Tailwind instead.
3. **The behavior is app-specific logic, not a generic control.** Examples: composer with markdown shortcuts and auto-grow, slash menu anchored to the caret, stick-to-bottom scrolling with "Jump to latest", inline-rename rows, provider test/fetch flow.
4. **Composition would repeat 3+ times.** Extract a wrapper (`SettingRow`, `StatusPill`, `ConfirmDialog`, `EmptyState`) rather than copy-pasting markup.
5. **The spec needs something the shadcn version lacks.** Examples: 56px icon-only sidebar plus 3px active bar, Windows caption buttons, Fluent-style switch sizing (40x20), 32px control height.

How to build a custom component:
- Compose from shadcn parts and Radix primitives first. Reach for raw elements only when needed.
- Style with Tailwind and the shadcn tokens (`bg-background`, `text-muted-foreground`, `border`, `ring`). No hard-coded colors except the caption close red `#C42B1C`.
- Typed props, one responsibility, under ~150 lines. Split if bigger.
- Real `<button>` elements, `aria-label` on icon-only buttons, visible focus ring, focus trap and Esc on overlays (Radix gives this for free; keep it).
- Never edit `components/ui/*` to add app behavior. Wrap it.
- If a custom component replaces something shadcn offers, leave a one-line comment saying why.

## 5. Theming

Map SPEC 3.4 tokens onto shadcn variables in `globals.css` (light and `.dark`):

```
--background  <- --surface      --card        <- --surface
--muted       <- --surface-2    --border/--input <- --border
--foreground  <- --text         --muted-foreground <- --muted
--primary     <- --accent       --primary-foreground <- --accent-contrast
--destructive <- --danger       --sidebar     <- --sidebar
window/title bar bg (mica) = extra token --window <- --bg
--radius: 0.5rem (8px); modals use rounded-xl (12px); small buttons rounded-sm (4px)
```

Accent presets from SPEC 3.4 set `--primary` at runtime. Theme = Light / Dark / System via class on `<html>`. Chat font size = `--fs` CSS var. Default control height 32px (`h-8`), compact 28px (`h-7`): adjust button/input sizes once in the theme layer.

## 6. Rules that carry over (do not break)

- UI-only: no network calls, no real providers. Fetch models, Test connection, replies, memory, artifacts are fake and timer-driven from `SEED`.
- Windows only: custom 32px title bar, caption buttons, Ctrl shortcuts, never Cmd.
- Implement every shortcut in SPEC 3.3 with one global `keydown` hook in `lib/shortcuts.ts`.
- Persistence: localStorage only for theme, accent, font size, sidebar collapsed, onboarding flag, default model. Wrap in try/catch.
- Min width 900px. Artifact panel overlays under 1100px.
- No features outside SPEC. No extra libraries beyond: react, zustand (optional), react-hook-form, zod, lucide-react, sonner, cmdk, and what shadcn installs.
- Respect `prefers-reduced-motion`.

## 7. Build order (verify each step runs before the next)

1. Scaffold, Tailwind, shadcn init, tokens, theme switching, TitleBar + AppShell.
2. Sidebar (chat groups, row menu, rename, delete confirm, collapse).
3. Chat view: Markdown, MessageList, Composer, streaming engine, message actions.
4. ModelPicker, ContextBar, compact flow, slash menu.
5. Artifact panel.
6. Settings dialog: all 8 pages, search, Providers dialog.
7. Projects grid and detail.
8. Command palette and global shortcuts.
9. Onboarding.
10. Polish: focus rings, empty states, 900px layout, reduced motion.

## 8. Definition of done

- `npm run dev` starts with no console errors and `npm run build` passes type-check.
- Every item in SPEC section 16 passes.
- No shadcn file in `components/ui/` contains app logic.
- Every custom component that sits where a shadcn one could have gone has a one-line reason (rule 4).

## 9. MASTER PROMPT (paste with SPEC.md and this file)

```
You are building "Clauro", a UI-only Windows-style BYOK chat prototype. Read SPEC.md for behavior and SUPER_PROMPT_SHADCN.md for the stack. Use Vite + React + TypeScript + Tailwind + shadcn/ui. Follow the component map (section 3) for which shadcn component to use for each UI piece, and the custom-component rule (section 4): use shadcn by default, but build a new component when there is no equivalent, when shadcn would need heavy overriding, when the logic is app-specific, or when a pattern repeats 3+ times. Never edit components/ui for app logic. All data is fake and lives in SEED. No network calls. Follow the build order in section 7 and satisfy SPEC section 16. Work in small verified steps. At the end, print how to run it and list any custom components you built where shadcn could have been used, with the reason.
```
