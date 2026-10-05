# Clauro — DESIGN.md

How the product looks and behaves, and why each surface is the way it is. Wire shapes and types live
in `CONTRACTS.md`; this is the intent behind them.

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

## 2. Surfaces

### 2.1 Projects rail

A project is a named container with an instruction block, its own memory space, its own files, and
its own workspace directory. **Memory is scoped per project** — that is what makes memory useful
rather than a flat notepad.

Gemini's Gems are folded in: a Gems-style "personal expert" is a project with instructions and files
and nothing else. One concept, not two.

### 2.2 Transcript

Append-only, and the UI reflects that honestly. **Nothing disappears and nothing is deleted.** A
compaction writes a `compaction_event` row and a `summary` block; the rows it covers are *superseded*,
not removed (`D84`). Superseded rows stay on disk so the append-only guarantee is auditable — the row
is still there to check against. The transcript shows the `summary` in place, with a "replayed"
affordance; it does not pretend the earlier blocks never existed.

| Block | Rendering |
|---|---|
| text | markdown, streamed |
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

`+` menu carries the per-chat memory toggle, **attach a file**, and, once a project opts in, `bash`.

**Attaching copies the file into the session workspace and says so.** The model never receives the
bytes inline — it receives a path, a size, and a media type, and reads the file itself with `fs`. The
user sees the real path and the real size, because that is what `fs` will be handed. **D47.**
Attachments dedupe per project, so the same file in two projects is stored twice and the UI shows the
resolved path rather than implying a shared copy. **D52.**

**Memory off shows a crossed-out icon next to the chat title. Memory on shows nothing at all.**
Absence as signal — no extra chrome for the common case.

### 2.6 Settings

Flat and short. Providers and keys · models · appearance · **memory** (the Topics list — select to
read, edit, delete) · projects · data (export, delete everything).

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
generation — in that order.

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

## 5. Motion and density

Transitions are 120–180 ms and only on things that genuinely move: drawer collapse, card expand,
tool row settle. **Nothing animates on stream arrival** — text appearing is not an animation.

Comfortable density by default with a compact option. Tool rows are single-line until hovered or
expanded, because a transcript where every tool call is three lines tall is unreadable past ten turns.

## 6. What we deliberately do not have

No dark-mode-only art direction. No onboarding tour. No emoji in product chrome. No
settings-because-we-can. No empty-state illustrations — an empty drawer is an empty drawer, and
saying so is faster than drawing it.

And no voice. It is a real feature, it is not ours, and the Web Speech API would make it look like
ours.