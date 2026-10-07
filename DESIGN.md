# Clauro — DESIGN.md

How the product looks and behaves, and why each surface is the way it is. Wire shapes and types live
in `CONTRACTS.md`; concrete tokens, layout rules and checks live in `UI-GUIDE.md` (**binding** for any
UI work); this is the intent behind them.

---

## 1. The window

```
┌─────────────────────────────────────────────────────────────┬──────────────┐
│ ☰  Clauro                    [project ▾]  [model ▾]  ⚙  ⌘K    │              │
├───────────┬─────────────────────────────────────────────────┤   ARTIFACT   │
│           │                                                 │   DRAWER     │
│ PROJECTS  │   transcript                                    │              │
│  ▸ Clauro │                                                 │  ┌────────┐  │
│  ▸ Side   │   ┌─────────────────────────────────────────┐   │  │        │  │
│           │   │ you: refactor the tokenizer             │   │  │ live   │  │
│ THREADS   │   └─────────────────────────────────────────┘   │  │ render │  │
│           │                                                 │  │        │  │
│  today    │   ┌─────────────────────────────────────────┐   │  └────────┘  │
│    · auth │   │ ▸ thinking (collapsed, 4 lines)        │   │              │
│    · memo │   │ I will start by reading the lexer.      │   │ [Preview]    │
│           │   │                                         │   │ [Code]       │
│           │   │  read  src/lex.rs                        │   │              │
│           │   │  ────────────────────  412 lines       │   │  copy  ⤓    │
│           │   │  tool_result · ok                       │   │              │
│           │   └─────────────────────────────────────────┘   │              │
│           │                                                 │              │
├───────────┴─────────────────────────────────────────────────┤              │
│ +  ⏵ memory:on  thinking:high          ⏎ send      ⏹       │              │
└─────────────────────────────────────────────────────────────┬──────────────┘
                                                                 hidden when empty
```

**The drawer is a third column, not an overlay.** It is the reason the artifact security model can be
strict: a real layout slot means we never have to raise it over content, never need a z-index
argument, and never compromise the CSP to get a floating window to behave.

It collapses to zero width when there is no artifact. It does **not** overlay the transcript at
narrow widths — the user collapses it deliberately.

### 1.1 Layout invariants (non-negotiable)

These exist because a shipped UI broke every one of them (composer collapsed to a one-character
column, root scrolled horizontally).

- **The root never scrolls.** `html`, `body`, `#root` are viewport-sized with `overflow: hidden`.
  Scrolling exists only in inner regions: transcript, sidebar list, settings pane, drawer, and the
  composer textarea past its max height. Not one root scrollbar, at any window size down to
  800×600.
- The shell is a three-column grid `auto | minmax(0,1fr) | auto`. Every flex/grid child that holds
  text or inputs carries `min-w-0` / `min-h-0`.
- The composer is a **column** (input above, toolbar below), never a single row. Content columns use
  `w-full max-w-*`, never `100vw` or fixed widths.
- Notices (no provider, errors) are full-width inline banners, never squeezed into a toolbar.
- The same UI must render identically in the browser harness (`pnpm dev:web`, port 1420, Tauri
  stubbed) and in `pnpm tauri dev`. Layout is verified by screenshot and by the scroll/size
  assertions in `UI-GUIDE.md` §9, not by reading code.
- Type: sans for UI, serif for the greeting and page titles, mono only for code, paths and tool rows.
- Icons: `lucide-react` only. No emoji or text glyphs in product chrome.

## 2. Surfaces

### 2.1 Projects rail

A project is a named container with an instruction block, its own memory space, its own files, and
its own workspace directory. **Memory is scoped per project** — that is what makes memory useful
rather than a flat notepad.

Gemini's Gems are folded in: a Gems-style "personal expert" is a project with instructions and files
and nothing else. One concept, not two.

The rail renders on the vendored shadcn `Sidebar` (`Tasks/025`, **D112**) — collapsible icon rail,
keyboard shortcut, mobile sheet — owned by `Tasks/018`. No hand-rolled collapse: the a11y contract
(focus, `aria`, escape) ships with the primitive. Anatomy: header (mark, collapse), New chat, Search,
Projects, then project groups with nested threads, then Recent; footer holds Settings. Rows are
themed `SidebarMenuButton`s — never raw text (`UI-GUIDE.md` §6).

### 2.2 Transcript

Append-only, and the UI reflects that honestly. **Nothing disappears and nothing is deleted.** A
compaction writes a `compaction_event` row and a `summary` block; the rows it covers are *superseded*,
not removed (`D84`). Superseded rows stay on disk so the append-only guarantee is auditable — the row
is still there to check against. The transcript shows the `summary` in place, with a "replayed"
affordance; it does not pretend the earlier blocks never existed.

| Block | Rendering |
|---|---|
| text | markdown, streamed, in a `ghost` bubble — full-width, unframed (Claude-like assistant row, shots 03/05) |
| user turn | `align="end"` bubble (shots 04/07) — the only framed row |
| thinking | **collapsible inline region, one shape for both providers.** Collapsed by default; shows a one-line preview. Never a side pane — that competes with the drawer for the same space during exactly the turns where both matter. |
| tool_use / tool_result | one row. Name, status, bounded preview, expandable. `ok`, `error`, `aborted`, `rejected` are visually distinct, and **all four are results** — nothing reads as a crash. |
| question_card | inline card, see §2.3 |
| summary | the checkpoint, in a `<details>`-style region with a "replayed" affordance |
| compaction | the provider's own compaction block, Anthropic only. Opaque to the user; its presence means the surface came from the server, not from us (`D69`, `D84`) |
| notice | dropped thinking, provider errors, ignored stream events — **never** the compaction itself |

### 2.3 The `question` card

Renders **inline, never as a modal.** A modal breaks the stream and throws away scroll position;
inline, the turn visibly pauses at the point of the question, which is also the honest description of
what is happening.

Both MIT references do the opposite — OpenCode docks to the composer, DeepSeek puts a card in the
bottom `min(60vh, 520px)`. **This is a deliberate divergence**, recorded because it is the one place
we knowingly disagree with every reference we learned from.

Always offers "skip / decide for me". **One question per assistant turn.** A model that can ask
unlimited questions will stall a session and spend tokens on repeated clarification. The cap plus an
always-present escape makes it an affordance rather than an interrogation.

### 2.4 Artifact drawer

Three states, and they are the whole design:

1. **empty** — zero width, no chrome
2. **compiling** — a spinner that says *compiling*, because Sucrase is not instant and silence reads
   as a hang
3. **live** — the rendered page

The drawer column itself stays a plain layout slot (its tests pin `aside`/sandbox tokens), not a
shadcn `Sidebar` — the drawer is a render surface with security assertions, not navigation chrome.
What shadcn owns around it: the projects rail (`Sidebar`, `018`), `bash` approval (`Dialog` —
never a palette action, `012`/`020`), the settings overlay (`Dialog`, §2.6), and the model picker
(`Select`, `025`).

Tabs: none in v1 — one live render, no history, no pinning, no Preview/Code
tabs and no download. (`SPEC.md` §5 defers all of those to v2: the render
must be trustworthy before a user can pin history. An earlier draft of this
section promised tabs, copy and download; that contradicted the spec and was
corrected.)

The render is **completely offline.** No CDN, no network, `connect-src 'none'`. Artifacts may only
use Tailwind's *predefined* utility classes — which is precisely what makes a no-build-step Tailwind
possible inside them, and why the system prompt says so explicitly.

The model is told that `localStorage`, `sessionStorage` and `indexedDB` are unavailable. This is the
single most common cause of a blank artifact, and it costs one line of prompt to avoid.

### 2.5 Composer

A rounded card with three rows: attachment chips (when present), an auto-growing textarea (1→12 rows,
then it scrolls internally), and a toolbar. Anatomy and code shape in `UI-GUIDE.md` §5.

```
┌───────────────────────────────────────────────────────────────┐
│ [chip: report.pdf · 120 KB ✕]                                 │
│ Write a message…                                              │
│ [+] [Memory] [Thinking: Medium ▾] ····· [Model ▾] [Mic] [Send]│
└───────────────────────────────────────────────────────────────┘
        Clauro runs on your machine. Double-check important answers.
```

**Input parity with the Claude app** (minus what is deliberately not ours — accounts, upsell,
voice). The composer supports:

- Enter sends, Shift+Enter newline, IME-safe; per-thread drafts persisted
- Attach via `+`, drag-and-drop, and paste (images, files, long text offered as a "Pasted text" chip)
- Image attachments only when the selected model supports vision; otherwise disabled with its reason
- `/` slash commands (`/compact`, `/clear`, `/model`, `/memory`, `/project`, `/thinking`) and `@`
  project-file mentions, both as popovers
- Provider-grouped model picker whose last entry, "Add provider…", opens Settings → Providers
- Thinking-effort select (Off/Low/Medium/High), hidden when the model has none
- Web-search / tool toggles, shown only when the provider advertises them
- Context meter (used / capacity) that turns to a warning near the limit and offers `/compact`
- Send turns into Stop during a turn; typing stays enabled; `↑` on an empty box edits the last user turn
- Voice renders disabled with its reason (§6)

`+` menu carries the per-chat memory toggle, **attach a file**, and, once a project opts in, `bash`.

**Attaching copies the file into the session workspace and says so.** The model never receives the
bytes inline — it receives a path, a size, and a media type, and reads the file itself with `fs`. The
user sees the real path and the real size, because that is what `fs` will be handed. **D47.**
Attachments dedupe per project, so the same file in two projects is stored twice and the UI shows the
resolved path rather than implying a shared copy. **D52.**

**Memory off shows a crossed-out icon next to the chat title. Memory on shows nothing at all.**
Absence as signal — no extra chrome for the common case. (The toolbar chip is a control, not a status
indicator.)

**No providers configured:** an inline banner above the composer ("Add a provider to start chatting",
button into Settings → Providers); Send is disabled; the model picker reads "No model". The message
is never placed inside the toolbar.

Under the composer, one line in our own words: the app runs locally and important answers deserve a
second look. Never Anthropic's disclaimer wording (**D39**). It stays on a single line and truncates.

### 2.7 App views (home · projects · project · chat)

The shell routes four views, all in our own words and layout (**D39** — behaviour mirrored from the
reference screenshots, never text):

- **home** — time-of-day greeting (never a name, never a logo), centered composer, a link into
  projects. No plan badges, no accounts, no upsell: there is nothing to upgrade to. Greeting and
  composer are centered as one column, `max-w-[720px]`, vertically centered, nothing scrolls.
- **projects** — card grid with search, one card per project, `New project` CTA.
- **project** — breadcrumb back to projects, title, right rail with Instructions / Memory (topic
  count) / Context (capacity used) panels.
- **chat** — the catalogue + composer + drawer surface from §1.

The rail nests child threads under their project. No `Chat | Cowork` mode switch exists to switch
to, and voice renders disabled with its reason — both deliberate (`Tasks/027`).

### 2.8 Command palette

Opens on Ctrl/Cmd+K (in-app; the Tauri global-shortcut plugin is a recorded follow-up). Blocked
with a reason while a turn runs; `/compact` unavailable mid-turn; `bash` approval and `attach`
never live here. Search box, section tabs (All · Chats · Projects · Actions), recent items, and a
hint footer — all labels ours. Recents + type filter ship now; full-text chat search is v3.
Settings is reachable as an action; it opens the dialog in §2.6.

### 2.6 Settings

An **overlay, not a page**: a shadcn `Dialog` opened with Ctrl/Cmd+, , the rail's footer gear, the
palette, or the model picker's "Add provider…". Left section nav, right pane; each scrolls inside
the dialog, the dialog itself never scrolls. Esc closes it. Below ~720px the nav collapses to a
`Select`.

```
┌────────────────────────────────────────────────────────────┐
│ Settings                                                ✕  │
├─────────────┬──────────────────────────────────────────────┤
│ General     │  (section pane — own scroll)                 │
│ Providers   │                                              │
│ Models      │                                              │
│ Appearance  │                                              │
│ Memory      │                                              │
│ Projects    │                                              │
│ Tools & bash│                                              │
│ Data        │                                              │
└─────────────┴──────────────────────────────────────────────┘
```

Still flat and short — eight sections, no nested tabs, no setting without a reason:

| Section | Contents |
|---|---|
| General | language, send key, density |
| Providers | add / test / remove; base URL; key kept in the OS keychain and never echoed back |
| Models | default model; per-model thinking and vision flags |
| Appearance | theme, density, font size |
| Memory | the Topics list — select to read, edit, delete |
| Projects | list, rename, instructions, delete |
| Tools & bash | opt-in, working directory, the "nothing is remembered" approval note |
| Data | export; delete everything (confirmed in a nested `AlertDialog`) |

Stacking: the `bash` approval dialog always sits above Settings, and Settings never opens while an
approval is pending.

## 3. Platform asymmetry, made visible

Windows and Linux are not the same product and the UI does not pretend otherwise.

| | Windows | Linux |
|---|---|---|
| Engine | WebView2 (Chromium) | WebKitGTK |
| Risk | low | **open** |
| If the sandbox does not hold | — | **Artifacts disabled at runtime, with a notice naming the reason** |

The Linux notice is not an apology. A feature that works on one platform and is unsafe on the other
is a worse product than a feature that is honestly absent. `bash` is **not** affected — it is a
host-side capability, root-confined and opt-in regardless of engine.

## 4. Interaction principles

**Keyboard-first.** Global hotkey summons the window. `⌘K` is the command palette and is the primary
navigation surface, not a shortcut. Escape collapses the drawer, then closes the palette, then stops
generation — in that order. (An open dialog takes Escape first.)

**Stop never loses work.** A cancelled turn keeps everything completed and closes every dispatched tool
call with an aborted result. Rollback would throw away work already done, and would leave an
unanswered tool call in a log we promised was balanced.

**Failures are results.** A missing file, a rejected command, a rate limit, a provider error — all
land in the transcript as something the model reads and can respond to. Nothing throws across the
tool boundary, and a non-zero exit is `ok` with output attached.

**Nothing is remembered without asking.** `bash` approvals are per-invocation and persist nothing.
No trust-on-first-use, no seeded allowlist. The interrupting cost *is* the feature: a persisted
allowlist would let a prompt-injected model run unattended with nothing in the UI saying so.

**`bash` opt-in notes, exact copy.** On Anthropic: "bash is now available to this conversation."
On the OpenAI-compatible adapter: "bash needs a new thread here — this one keeps its frozen tool
set." The UI must never claim a fresh thread is required when it is not. The approval dialog shows
the exact command and the working directory it runs in, with Approve and Reject side by side; a
rejection lands in the transcript as a rejected result, and a non-zero exit lands as `ok` with its
output attached.

**Every control has every state.** Default, hover, focus-visible, active, disabled-with-reason,
loading; every list has an empty and an error state in one plain sentence (`UI-GUIDE.md` §8).

## 5. Motion and density

Transitions are 120–180 ms and only on things that genuinely move: drawer collapse, card expand,
tool row settle, dialog open. **Nothing animates on stream arrival** — text appearing is not an animation.

Comfortable density by default with a compact option. Tool rows are single-line until hovered or
expanded, because a transcript where every tool call is three lines tall is unreadable past ten turns.

## 6. What we deliberately do not have

No dark-mode-only art direction. No onboarding tour. No emoji in product chrome. No
settings-because-we-can. No empty-state illustrations — an empty drawer is an empty drawer, and
saying so is faster than drawing it.

And no voice. It is a real feature, it is not ours, and the Web Speech API would make it look like
ours. The mic stays visible but disabled, with its reason in the tooltip.

## 7. UI acceptance

A UI change is not done until: it renders the same in `pnpm dev:web` and `pnpm tauri dev` on port
1420; screenshots at 1920×1080, 1280×720, 1024×640 and 800×600 show no root scrollbar and no
clipped or off-centre content; the scroll/size assertions pass; and the critique rubric in
`UI-GUIDE.md` §10 scores ≥ 9 on every axis, logged in `UI-CRITIQUE.md`.
