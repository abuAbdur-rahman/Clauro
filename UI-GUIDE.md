# Clauro — UI-GUIDE.md

Concrete rules for building the UI. `DESIGN.md` says *what and why*; this says *exactly how*.
Source of truth for look: `../reference/images/*`. Where tokens below disagree with the images,
sample the images and update this file.

---

## 1. Why the last UI failed (root causes → fixes)

| Symptom (screenshots) | Cause | Fix |
|---|---|---|
| Textarea is a 1-char vertical column | Composer is a single flex **row**; textarea has no `flex-1`/`w-full`, no `min-w-0` | Composer is a **column**: textarea on top, toolbar row below |
| Horizontal scrollbar on root, content pushed off the right edge | Root not locked; main column wider than viewport | `html,body,#root{height:100%;overflow:hidden}` + grid shell + `min-w-0` |
| Provider notice wraps one word per line | Notice placed inside the toolbar row | Notice is a full-width inline banner above the composer |
| Sidebar = raw unstyled text | shadcn `Sidebar` not themed / Tailwind not scanning those files / CSS vars missing | Verify `@import`/`content` globs, token vars in `:root`, use `SidebarMenuButton` |
| Everything monospace | `font-mono` on body | Sans body, serif greeting, mono only for code |
| Greeting + composer off-center, right-aligned | Centering applied to a child wider than its parent | `mx-auto w-full max-w-[720px]` inside a `min-w-0` column |

## 2. Tokens

Dark theme default; light theme mirrors it. Define on `:root` / `.dark` (shadcn convention), never
inline hex in components.

```css
:root {            /* dark values shown; light = inverse, same roles */
  --bg:            #1f1e1d;   /* app background            */
  --bg-sidebar:    #1a1918;   /* rail                      */
  --bg-elevated:   #2a2927;   /* composer, cards, dialogs  */
  --bg-hover:      #34332f;
  --border:        #3a3835;
  --fg:            #f2efe9;
  --fg-muted:      #a8a39a;
  --fg-subtle:     #77726a;
  --accent:        #d97757;   /* one accent: send btn, focus ring, active */
  --danger:        #e5484d;
  --radius-sm: 8px; --radius-md: 12px; --radius-lg: 20px; /* composer = lg */
}
```

Typography (no webfonts fetched at runtime — app is offline-first; bundle or use system stacks):

| Role | Family | Size / weight |
|---|---|---|
| UI / body | `Inter, system-ui, sans-serif` | 14px / 400, line-height 1.5 |
| Greeting / page titles | `ui-serif, Georgia, serif` | 36–40px / 400 |
| Transcript text | sans | 15px / 400, line-height 1.65 |
| Code, paths, tool rows | `ui-monospace, "JetBrains Mono", monospace` | 13px |
| Labels, captions | sans | 12px / 500, `--fg-muted` |

Spacing: 4px base (`1,2,3,4,6,8` in Tailwind). Controls are 32px tall (36px composer buttons).
Icons: `lucide-react`, `size-4` (16) in chrome, `size-5` in composer buttons, `strokeWidth={1.75}`.

## 3. Shell (root never scrolls)

```
html, body, #root ─────────── h-dvh w-screen overflow-hidden
└─ <div class="grid h-full w-full grid-cols-[auto_minmax(0,1fr)_auto]">
   ├─ Sidebar        260px | 48px collapsed(icon rail)   own inner scroll (list only)
   ├─ <main class="flex min-w-0 flex-col">
   │   ├─ topbar     h-12 shrink-0
   │   ├─ transcript flex-1 min-h-0 overflow-y-auto       ← the ONLY vertical scroller
   │   └─ composer   shrink-0
   └─ Drawer         0 | 420–560px, resizable             own inner scroll
```

Rules: `min-w-0`/`min-h-0` on every flex/grid child that can hold content. No `100vw` (includes
scrollbar width) — use `w-full`. No fixed pixel widths on content columns; use `max-w-*` + `w-full`.
Below 800px the drawer and sidebar are collapsed by the user, never auto-overlaid (DESIGN §1).

## 4. Home view

```
              ┌──────────────────────────────┐
              │   Good afternoon             │  serif 40px, centered, mb-8
              │ ┌──────────────────────────┐ │
              │ │ Write a message…         │ │  composer, max-w-[720px] w-full
              │ │                          │ │
              │ │ [+] [mem] [Medium▾] ··· [model▾] [🎙][↑] │  (lucide icons, not emoji)
              │ └──────────────────────────┘ │
              │   Browse projects · Providers │  text buttons, 13px muted
              └──────────────────────────────┘
        vertically centered (flex items-center justify-center), nothing scrolls
```

## 5. Composer anatomy

```
┌───────────────────────────────────────────────────────────────┐
│ [attachment chips: icon · name · size · ✕]        (if any)    │  row 1: wrap, gap-2
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ Write a message…                                          │ │  row 2: <textarea>
│ │                                                           │ │  w-full, rows auto 1→12,
│ └───────────────────────────────────────────────────────────┘ │  then inner scroll
│ [+]  [Memory ●]  [Thinking: Medium ▾]  ·····  [Model ▾] [Mic] [Send] │ row 3: toolbar
└───────────────────────────────────────────────────────────────┘
```

```tsx
// Composer.tsx — the shape that must not regress
<form className="mx-auto w-full max-w-[720px] rounded-[20px] border border-[--border] bg-[--bg-elevated] p-3">
  {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2">…</div>}
  <Textarea className="w-full min-h-[44px] max-h-[40vh] resize-none border-0 bg-transparent
                       focus-visible:ring-0" />          {/* NOT inside a flex-row with the toolbar */}
  <div className="mt-2 flex min-w-0 items-center gap-1">
    <PlusMenu />  <MemoryToggle />  <ThinkingSelect />
    <div className="flex-1" />                           {/* spacer pushes right group */}
    <ModelSelect className="min-w-0 max-w-[200px] truncate" />  <MicButton disabled />  <SendButton />
  </div>
</form>
```

Toolbar overflows? Collapse from the left: Memory and Thinking become icon-only (tooltip
carries the label), then move into the `+` menu. Never wrap the toolbar to two lines, never push it
off-screen.

### 5.1 Input capabilities (parity with the Claude app, minus what is not ours)

| Capability | Behaviour |
|---|---|
| Send / newline | `Enter` sends, `Shift+Enter` newline; `Ctrl/Cmd+Enter` setting. IME-safe (ignore while composing) |
| Auto-grow | 1 row → 12 rows, then scrolls inside |
| Attach | `+` menu → file picker; **drag-and-drop** onto window (overlay hint "Drop to attach"); **paste** images/files. Chip shows resolved path + size (D47/D52) |
| Images | thumbnail chip, click to preview; only enabled if the selected model supports vision, else disabled with reason |
| Slash commands | typing `/` opens a Command popover: `/compact`, `/clear`, `/model`, `/memory`, `/project`, `/thinking`; blocked mid-turn with reason |
| Project / file mention | `@` opens a popover over project files (attach by reference) |
| Model + provider | `Select` grouped by provider; last group item "Add provider…" opens Settings → Providers. No providers → picker shows "No model", Send disabled, banner above composer |
| Thinking effort | `Select`: Off · Low · Medium · High (hidden if model has no thinking) |
| Memory | per-chat toggle in `+` menu **and** compact chip; off = crossed icon beside title (DESIGN §2.5) |
| Web search / tools | toggle appears in `+` menu only when the provider/model advertises it |
| bash | in `+` menu once the project opts in (DESIGN §4 exact copy) |
| Context meter | small ring or `12k / 200k` in toolbar tooltip; turns `--danger` ≥ 90%; click → `/compact` |
| Stop | Send becomes Stop (Square icon) during a turn; `Esc` order per DESIGN §4 |
| Queue / edit | while a turn runs, typing is allowed; Send is disabled with "Stop to send"; `↑` on empty input edits the last user message |
| Drafts | per-thread draft persisted; restored on reopen |
| Voice | Mic rendered **disabled** with tooltip reason (DESIGN §6) |
| Paste long text | > 5k chars offered as an attachment chip ("Pasted text") |
| Footer line | one-line caption under composer, 12px muted, centered, single line, `truncate` |

## 6. Sidebar

Header: logo mark + wordmark, collapse button (`PanelLeft`). Then **New chat** (`SquarePen`),
**Search** (`Search`, opens ⌘K), **Projects** (`FolderKanban`). Below: `PROJECTS` group (collapsible
projects, each with child threads), then `RECENT`. Footer: Settings (`Settings`) opening the dialog.
Rows are 32px, `rounded-md`, hover `--bg-hover`, active `--bg-hover` + 2px left accent bar,
truncate with ellipsis, `…` menu (`MoreHorizontal`) on hover: rename, move, delete. Use
`SidebarMenuButton`/`SidebarGroup`; no raw `<div>` rows.

## 7. Settings — shadcn `Dialog`, not a page

Opens with `Ctrl/Cmd+,`, the footer gear, the model picker's "Add provider", and the palette. `Esc` closes it.

```
┌──────────────────────────────────────────────────────────────┐
│ Settings                                                  ✕  │ DialogHeader
├──────────────┬───────────────────────────────────────────────┤
│ General      │  Providers                                    │
│ Providers  ◀ │  ┌─────────────────────────────────────────┐  │
│ Models       │  │ Anthropic   key ••••3f2a  [Test] [Remove]│  │
│ Appearance   │  ├─────────────────────────────────────────┤  │
│ Memory       │  │ OpenAI-compatible  base URL …            │  │
│ Projects     │  └─────────────────────────────────────────┘  │
│ Tools & bash │  [+ Add provider]                             │
│ Data         │                                               │
└──────────────┴───────────────────────────────────────────────┘
 DialogContent: w-[min(920px,calc(100vw-2rem))] h-[min(640px,calc(100dvh-2rem))] p-0
 nav: 200px, own scroll   |   pane: flex-1 min-w-0, own scroll   (dialog itself never scrolls)
```

Sections: **General** (language, send-key, density) · **Providers** (add/test/remove, base URL, key
stored in OS keychain, never echoed) · **Models** (default model, per-model thinking/vision flags) ·
**Appearance** (theme, density, font size) · **Memory** (Topics: select/edit/delete) · **Projects** ·
**Tools & bash** (opt-in, working dir, approval note: nothing persisted) · **Data** (export, delete
everything, confirm via nested `AlertDialog`). Below 720px width the nav becomes a top `Select`.
The `bash` approval `Dialog` always stacks above Settings.

## 8. Component state checklist

Every interactive element needs: default, hover, focus-visible (2px `--accent` ring), active, disabled
(with tooltip reason), loading. Every list needs empty and error states in one plain sentence.
No-provider state: banner above the composer — `KeyRound` icon, "Add a provider to start chatting",
primary button "Open Providers". One line on ≥ 480px.

## 9. Automated checks (run per viewport: 1920×1080, 1280×720, 1024×640, 800×600)

```ts
// e2e/layout.spec.ts
for (const vp of viewports) test(`no root scroll @${vp.width}`, async ({ page }) => {
  await page.setViewportSize(vp); await page.goto("http://localhost:1420");
  const { sw, cw, sh, ch } = await page.evaluate(() => {
    const e = document.scrollingElement!;
    return { sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight };
  });
  expect(sw).toBeLessThanOrEqual(cw); expect(sh).toBeLessThanOrEqual(ch);
  const ta = await page.getByRole("textbox").boundingBox();
  expect(ta!.width).toBeGreaterThan(300);                 // never a sliver
  expect(ta!.x + ta!.width).toBeLessThanOrEqual(vp.width); // never off-screen
});
```
Also assert: toolbar height < 56px (never wraps), fonts computed on `body` is not monospace,
no element's `getBoundingClientRect().right > innerWidth`, every `svg` icon comes from lucide.

## 10. Critique rubric (score 0–10, all ≥ 9 to ship; log in `UI-CRITIQUE.md`)

1. **Reference fidelity** — side-by-side with `../reference/images/*`; list differences
2. **Layout integrity** — no root scroll, no overflow, no clipped/off-center content at 4 viewports
3. **Typography** — hierarchy, sans/serif/mono roles, line length ≤ 75ch in transcript
4. **Spacing & alignment** — 4px grid, consistent padding, optical centering
5. **Color & contrast** — one accent, text ≥ 4.5:1, borders subtle
6. **Components & states** — every state in §8 present
7. **Composer** — everything in §5.1 works or is honestly disabled
8. **Keyboard & a11y** — tab order, focus rings, `aria`, Esc order
9. **Provider/Settings flow** — from zero providers to first message in ≤ 4 clicks

## 11. Anti-patterns (instant reject)

Vertical text columns · root scrollbar · `font-mono` body · emoji or text glyphs as icons ·
hand-rolled sidebar/dialog/select · `100vw` · hard-coded hex in components · content wider than its
parent · toolbar that wraps · notices inside the toolbar · settings as a full page · centered
layout achieved with `margin-left` hacks · "I'll polish later".
