# Clauro — DECISIONS.md

**A lightweight, local-first, BYOK desktop client for Claude.**
Status: **pre-plan.** This document is the input to a build plan. Everything here is decided unless
it appears in §8.

**Stack:** Tauri v2 (Rust) · React 19 · TypeScript 6 · Tailwind 4 · `lucide-react` (shell only, D96) · SQLite (`rusqlite`) · Zustand
**Platforms:** **Linux and Windows only.** Two webviews, two very different problems — WebView2 on Windows (Edge runtime) and WebKitGTK on Linux.
**Binary budget:** ~25 MB · **Telemetry:** none, ever · **Account:** none

---

## 1. The product in one paragraph

Clauro is a native desktop chat client for people who have their own API key and want their
conversations to stay on their machine. It chats with models across providers, renders artifacts as
live sandboxed pages, keeps per-project memory, and gets out of the way — summon it with a hotkey,
drive it from the keyboard, export or delete everything, never phone home. It is not an agent IDE
and it is not trying to become one.

## 2. Architecture at a glance

```
┌─ React 19 UI ──────────────────────────────────────────────┐
│  transcript · projects rail · artifact drawer · command    │
│  palette · settings                                         │
└──────────────┬──────────────────────────────┬─────────────┘
               │ Tauri IPC                    │ MessageChannel
┌──────────────▼──────────────┐   ┌───────────▼──────────────┐
│ Rust core                   │   │ Artifact iframe           │
│ · SQLite (threads, msgs,    │   │ srcdoc                   │
│   projects, memory,         │   │ sandbox="allow-scripts"   │
│   tool results)             │   │ NO allow-same-origin      │
│ · keyring (API keys)        │   │ CSP built in Rust         │
│ · SSE transport (reqwest)   │   │ connect-src 'none'       │
│ · tool host / bash runner   │   │ NO Tauri internals       │
└──────────────┬──────────────┘   └──────────────────────────┘
               │
      ┌────────▼─────────┐
      │ provider API     │  Anthropic · OpenAI · Google · local
      └──────────────────┘
```

Two boundaries carry the design. **The artifact iframe is an opaque origin that cannot reach
anything.** **The tool host owns all side effects; the model only proposes.**

The tool loop has no privileged path. Every tool — including `question` and `compact` — is proposed
by the model, dispatched by the host, and answered with an ordinary `tool_result` that lands in the
append-only log:

```
model ──tool_use──▶ host dispatch ──▶ tool
                                        │
        ◀────── typed tool_result ───────┘
                 (appended; D19 — never edited)
```

That uniformity is why compaction, memory, and a rejected `bash` command all survive a compaction
unchanged. It is also why a denied tool is removed from the *request* rather than filtered from the
response (D26) — if the model never saw it, it cannot call it, describe it, or be talked into it.

---

## 3. v1 scope

Eight tools. Four surfaces. Everything else is later.

### Tools

| Tool | Model-callable | Purpose |
|---|---|---|
| `memory` | ✅ | Topic store. Six commands, `/memories` → SQLite. |
| `artifact` | ✅ | Emits a live page into the drawer. **We define the schema.** |
| `web-search` | ✅ | Query + fetch. Claude-comparable results. |
| `web-fetch` | ✅ | Fetch a specific URL to text/markdown. |
| `fs` | ✅ | Read/write/edit/glob/grep. Rooted at the session workspace. |
| `compact` | ❌ **host-driven only** | Summarise history. Triggered by the host or `/compact`. |
| `bash` | ✅ **off by default** | Host command runner. Opted into per project. |
| `question` | ✅ | Model asks the user a structured question. Typed answer returns as a `tool_result`. |

### Surfaces

Projects rail · transcript · artifact drawer · command palette + global hotkey

### Also in v1

Incognito chats · thinking-effort control · per-thread model switching · theme (light/dark/system) ·
thread export (HTML/Markdown) · memory export (JSON) · **file attachments** — an upload is copied
into the session workspace, the model is told only path + size + type, and it reads the bytes itself
via `fs` (**D47**). Attachments are in v1 because `fs` is in v1 and needs something to read; dedupe is
per project (**D52**)

---

## 4. Decisions

Each is a choice, not a topic. **D-numbers are referenced by the build plan.**

### Artifacts

**D1 — Clauro defines its own `artifacts` tool. We do not parse any first-party wire format.**
Ask, don't parse. The model returns structured JSON; there is no fence to detect and no format to
reverse-engineer. This removed the single largest unknown in the project.

**D2 — The artifact frame is `srcdoc` + `sandbox="allow-scripts"`, never `allow-same-origin`.**
Adding `allow-same-origin` alongside `allow-scripts` removes the sandbox entirely: the document can
reach `parent.document` and strip the attribute. Omitting it puts the frame on an **opaque origin**,
which is the only reason it cannot read `window.__TAURI_INTERNALS__`. Tauri v2 gates commands by
capability and scope, **not by caller origin** — so any path from artifact to Tauri internals means
the artifact can run every command the app can.

> **Corrected 2026-10-03 (audit C1).** The opaque origin comes from the **`sandbox` attribute, not
> from `srcdoc`**. `about:srcdoc` *inherits the parent's origin*; the opaque origin is only forced when
> the sandboxing flags require it. The conjunction in D2 is correct — but the two halves must never
> be separated. If anyone adds `allow-same-origin` back for any reason, `event.origin` silently
> becomes the parent origin instead of `null`, and the D6 `event.origin` validation breaks at the same
> moment. **`srcdoc` is a transport choice; `sandbox` is the security boundary.**

**D3 — An artifact's network surface is closed by CSP, for fetch and every subresource.**
`connect-src 'none'` blocks `fetch`/XHR/WebSocket; `default-src 'none'` (`D83`) blocks remote scripts,
images, fonts and frames; `form-action 'none'` blocks form posts. The first-party product allowlists
five public CDNs; we vendor what we need and render fully offline.

**The claim is deliberately this narrow, not "no network egress" (`D90`).** WebRTC data channels
bypass `connect-src` and no browser ships a `webrtc` CSP directive; `dns-prefetch` is not gated by
what we set; self-navigation may escape the document policy; `window.open` is governed by `sandbox`,
not CSP. `Tasks/001` and `Tasks/014` probe each of these on both engines.

**D4 — JSX/TS artifacts compile in-browser with Sucrase inside a Worker, with a timeout and an output
size cap.** SVG passes through DOMPurify, shipped only in the artifact frame, not the main bundle.
The model is told in its system prompt that `localStorage`/`sessionStorage`/`indexedDB` are
unavailable — this is the most common cause of a blank artifact.

**D5 — Only predefined Tailwind utility classes.** No arbitrary values. This is precisely what makes
a no-build-step Tailwind possible in an artifact.

**D6 — Host↔artifact messaging is an explicit `MessageChannel` handshake with an allowlist, and
`event.origin` + `event.source` are validated on every message in both directions.** A first-party
client shipped a blank-artifact bug from exactly this class of origin mismatch. The opaque origin comes from the `sandbox`
attribute (`D2`) — `about:srcdoc` inherits the parent origin on its own — so validate
`event.source === iframe.contentWindow` and reject unexpected
non-null origins.

### Memory

**D7 — Memory is a topic store written by the model, not an out-of-band extractor.**
Six commands: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. `/memories/<path>` maps
to the SQLite `key` column and `category` **is** the topic.
> **Reconciled 2026-10-03.** D7 originally named Anthropic's `memory_20250818` tool type and quoted
> its injected protocol verbatim. Both were wrong for Clauro. **D51** decided the memory tool is
> **Clauro's own, used on every provider** — Anthropic's built-in type does not exist on other
> providers, so naming it would have broken the single-code-path promise. And D39 forbids reusing
> wording from proprietary docs, so the quoted line was removed rather than kept. Clauro writes its
> own memory protocol instruction instead, conveying the same intent: context may be lost, so record
> progress as it happens. The *behaviour* is mirrored from the first-party app; no text is copied.

**D8 — Three separate controls, never collapsed into one toggle.** Account **pause** (keep memory,
stop using, stop writing, not backfilled on resume) · account **reset** (permanently delete,
irreversible) · per-chat **off** (set before the first message, locks after). Sensitive topics are a
fourth, off by default, with a review notice above the composer on every save.

**D9 — Per-chat memory toggle shows a crossed-out icon next to the chat title when off, and no icon
at all when on.** Absence as signal.

**D10 — Memory outlives its source conversation.** Deleting a chat does not delete memories derived
from it. Adopt knowingly; individual memories are always deletable.

**D11 — Never inject memory into `system` or early messages.** Memory is retrieved just-in-time by
the model. Preloading it duplicates the API's own protocol and fights it.

### Compaction

**D12 — Trigger: ratio 0.8, retained tail 0.16, with overflow recovery as a separate second path.**
> ⚠️ **The bare `0.8` below is superseded by `D82`.** `D82` caps every reserve term proportionally and
> floors the result, because the raw ratio went **negative** on any model below an 85,536-token
> window — the entire local-model class the second adapter targets. Read `D82` for the arithmetic.
Pressure is measured **at a turn boundary**, after a successful call, using the durable logged
envelope — never mid-call. `context-overflow` (the provider rejected the request) bypasses thresholds
entirely: prune oversized tool results first, remeasure, then summarise.

**D13 — The compaction summary call is a genuine prefix-extension of the warm request.**
The summarisation directive goes in a **trailing user message**, not a system prompt, so the leading
token sequence is byte-identical to the request that just warmed the KV cache. **`tools` are carried
through even though the summariser never calls one** — dropping them misaligns every following token
and defeats reuse. This is the difference between paying prompt cost once and paying it twice at
exactly the moment the conversation is largest.

**D14 — `compact` is host-driven and user-invocable. It is never a model-callable tool.**

> **The `/compact` command now maps to server-side on-demand compaction, which `D95`
> makes primary.** The decision that it is *host-driven* is unchanged: still never a tool.
An agent-invoked compact rewrites history mid-conversation — the operation the thinking prefix check
rejects with **HTTP 400** — and because Clauro is BYOK, account age varies per user, so it cannot be
tested away. Triggers: `/compact` command, the 0.8 pressure check, and overflow recovery.

**D15 — No client-side compaction on Anthropic models. Ever.**
`context − max(output, buffer)` math is for non-Anthropic providers only. Anthropic gets documented
server-side compaction and context editing.

**D16 — Summary is a fixed-section checkpoint.** Ordered sections, empty sections kept, terse
bullets, exact paths and identifiers preserved, and *"Do not mention the summary process or that
context was compacted."* Two extra rules in the trailing instruction: do not mention the
summarisation request, and output only the checkpoint text without calling a tool.

**D17 — Anti-thrash: a compaction that does not change the surface generation is not a compaction.**
If the context refills to the limit within a few turns of the last compact, repeatedly, stop and tell
the user rather than looping. Reject a summary that does not actually shrink.

**D18 — Never split an assistant tool call from its result.** The summarisable region always ends on
a tool-pairing-balanced boundary.

### Transport and providers

**D19 — History is append-only. `system` and `tools` are fixed for the life of a thread.**

> **Partly superseded by `D94`.** The *append-only* half stands and is reinforced — the
> `tool_addition`/`tool_removal` messages that change tools are themselves prefix-bound and must not
> be moved, reworded or deleted. The *frozen `tools` array* half stands only for the
> OpenAI-compatible adapter; on the Claude API the array is fixed at the first request and the
> **effective** tool set changes via `tool_addition`/`tool_removal` with `defer_loading: true`.
Removing a block and re-inserting it invalidates thinking produced while it was gone. The tool list
can be fixed per thread while the model can still change.

**D20 — Send `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` on every request** (beta
header `thinking-binding-controls-2026-08-01`). Note the provider's own caveat: dropped blocks are not
billed, but a session's usage may still rise because the model can think more to recreate them.

> **Corrected 2026-10-03 (audit C3).** It is **not** a top-level request field. The path is
> `thinking.block_binding.prefix_mismatch_behavior`. Sending it at the top level, or without the beta
> header, returns a 400 ending `block_binding: Extra inputs are not permitted`.

**D21 — Enable server-side context editing: `clear_tool_uses_20250919` + `clear_thinking_20251015`.**
`clear_thinking_20251015` must be listed **first**. The client always stores the **full, unmodified**
history — edits are applied server-side before the prompt reaches the model, so there is no edited
copy to sync.

> **Corrected 2026-10-03 (audit C2).** `compaction` and `context_management` are **mutually exclusive
> on a single request** — *"You can't combine `compaction` with `context_management` on one
> request."* The two beta *headers* may coexist; the two request *parameters* may not. So on an
> Anthropic thread the request builder branches: either a compaction request carrying `compaction`,
> or a normal request carrying `context_management.edits[]`. Never both.

**D22 — Set `clear_at_least` meaningfully high.** Clearing tool results invalidates the cached prompt
prefix; you pay cache-write every time. Clearing 300 tokens to save 300 is a net loss.

**D23 — Model catalogue is `models.dev`, fetched at runtime and cached. Never bundled.** MIT,
226 providers, 5.3 MB — larger than the entire binary budget.

**D24 — Hand-roll SSE over `reqwest`.** There is no official Anthropic Rust SDK (max version 0.0.8,
last updated 2024-09-03) and we do not build on an SSE crate either.

> **Corrected 2026-10-04.** This entry previously claimed both SSE crates were unmaintained. That
> became false: `reqwest-sse` 0.2.0 released 2026-05-08 and is maintained (MIT, six stars, one
> maintainer). It is recorded and not adopted — it covers only the framing layer while
> `CONTRACTS.md` §5's rules are event semantics we own either way. See `TECH_STACK.md` §3.1. **D97.**

**D25 — Tool schemas live in the request; `compactIfNeeded` takes intent, not token arithmetic.**
Compaction policy must not know how to count tokens. A separate token meter owns accounting.

### Tool host

**D26 — A denied tool is removed from the request entirely, not filtered from the results.**
It cannot be called, cannot confuse the model via its description, and cannot be socially engineered
into being called. Ported from OpenCode's `whollyDisabled()` → `registrations.delete(name)` path.

> **Corrected 2026-10-03 after audit 2.** D26 previously stated an evaluation order of
> **deny → ask → allow**. That precedence exists in **neither** MIT reference. What OpenCode actually
> implements is `findLast()` — most-recent matching rule wins — and that is the part that is ported.
> The three-way precedence below is **Clauro-original**, chosen because a fail-closed ordering is the
> safe one: if the match logic is ever wrong, `deny` must win.

**D27 — Tool output is bounded at the return boundary, not at write time.**
Full output goes to storage; the transcript gets a bounded preview plus a path the model can re-read.
Strictly better than truncating at 2,000 characters — nothing is lost.

**D28 — `bash` is off by default and opted into per project.**
It changes the security claim from *"never executes code on your machine"* to something narrower, and
that is a deliberate product decision, not an oversight.

**D29 — One host-owned command runner.** Process-group kills, output truncation with spill, a
credential scrub on the child environment, and fd 0 as `/dev/null` when no stdin is supplied.
The model-facing tool constructs requests **only from declared model arguments** — it exposes no
`stdin` and no `env` parameter, because shell syntax already covers both and duplicate parameters
would add surface without authority separation.

**D30 — Environment merge order is fixed and managed names win:**
`scrub(process.env)` → internal overrides → ordinary `env` → managed `dshEnv`. A model-supplied env
entry can never displace a managed value.

**D31 — `fs` is rooted in a Clauro-owned workspace tree.**
```
~/.clauros/                                    # or $CLAURO_DATA_DIR / XDG_DATA_HOME
  db.sqlite
  projects/<project-id>-<slug>/sessions/<session-id>-<slug>/
    attachments/          copied in on upload, deduped
    artifacts/<artifact-id>/
  sessions/<session-id>-<slug>/                # no-project sessions
```
Clauro owns the tree, attachments are copied in, and no arbitrary host path ever enters the picture.
A compromised session's blast radius is one directory.

**D32 — Opaque IDs are authoritative; slugs are cosmetic and length-capped.**
An AI-generated title is not a safe path component: it can contain separators, `..`, Windows
reserved device names (`CON`, `PRN`, `NUL`, `COM1`), can duplicate, and changes when regenerated. A
path must be stable. The human title lives in SQLite.

**D33 — `fs` preconditions are a state machine in the host, not a sentence in a prompt.**
Track read state per `(session, path)`. `edit` errors unless that path was read in this session.
Prompt rules are advisory; host state is authoritative.

**D34 — Windows security state is the DACL, not the mode bits.**
POSIX mode bits are a no-op on Windows — `chmod` drives only the read-only attribute and
`stat().mode` reports synthetic `0o666`/`0o444`. New files **inherit** from the destination directory,
so the staging directory is created inside `dirname(absolutePath)`, never in `%TEMP%`. Replacement
writes preserve the target's existing DACL. Do not invent an owner-only policy — it breaks
inheritance and surprises users whose project directories are deliberately shared. Resolve symlinks and
junctions **before** the traversal check, or the check is bypassable.

### Projects

**D35 — Projects are the scoping primitive, and Gems are folded into them.**
One concept: a named container with an instruction block, its own memory space, its own files, and
its own workspace directory. Per-project memory isolation is what makes memory useful rather than a
flat notepad.

**D36 — Threading and attachments are per-project.** Chat search is scoped within a project and
never leaks across.

**D37 — Incognito chats: a ghost icon that excludes the thread from history, search, and memory.**

> **Qualified 2026-10-04 by external audit.** Incognito is a **flag in the same SQLite file**, so
> the rows are on disk. "Excluded from history" means excluded from every *read path* — the
> sidebar, search, memory, and export all filter on the flag — not excluded from storage. The
> thread is not written to the database at all when memory is off AND the thread is deleted on
> close; that is the only honest reading, and `Tasks/019`'s delete-every-byte criteria govern it.

### Process

**D38 — Zero telemetry. Local file logs only.** Telemetry is opt-in by build and environment in the
reference implementations; we ship none at all.

**D39 — Nothing is copied from proprietary source.** Observed *behaviour* may be described; observed
*wording* may not be reused. Two MIT-licensed reference implementations contain first-party prompt
text verbatim — MIT cannot relicense it — so our `fs` and `edit` prompts are written from scratch.

### The question tool

> **Provenance note, added 2026-10-03 after audit 2.** D40 was the *only* one of D40–D43 ported from
> an MIT reference's builtin tool set. **D41, D42, and D43 are Clauro-original** — no reference
> implementation does any of the three. They previously sat under a table implying otherwise.

**D40 — `question` is a first-class tool, not prose.** *(ported)* The model emits a structured
question — single choice, multiple choice, or free text — and Clauro renders it as an inline card in
the transcript. The answer returns as an ordinary `tool_result`, so it lands in the append-only log
like any other tool result and survives compaction with no special handling. Ported from OpenCode's
builtin set, which ships `question` alongside `bash`, `edit`, `glob`, `grep`, `read`, `skill`,
`todowrite`, `webfetch`, `websearch`, `write`.

**D41 — The card renders inline in the transcript, not as a modal.** *(original divergence)* A modal
breaks the stream and throws away scroll position. The turn visibly pauses at the point of the
question, which is also the honest UX: the model is waiting on you.
> **Both MIT references do the opposite.** OpenCode ships `session-question-dock.tsx`; DeepSeek ships
> a bottom card capped at `min(60vh, 520px)`. Both take over the composer. Clauro is deliberately the
> odd one out — this is a divergence chosen for scroll-position integrity, not an inherited pattern,
> and it is the one place we knowingly disagree with every reference.

**D42 — The user can always decline, and the count is capped.** *(original — no reference caps
anything)* A model that can ask unlimited questions can stall a session and burn tokens on repeated
clarification. Cap at **one `question` call per assistant turn**, always offer a **"skip / decide for
me"** affordance, and render the answer as a resolved card so history stays readable. A model that
ignores the cap and loops is a model bug we must degrade gracefully from, not a UX we invite.

**D43 — Neither `question` nor `memory` carries secrets.** *(original — no reference filters
prompts)* Two durable channels, one guard. A `question` card is persisted into the thread, surviving
compaction and export, so the model must not be able to talk the user into pasting a credential into
it. A `memory` write lands in SQLite and is exported, so the model must not be able to talk itself
into storing one either — and if it does, the bytes are already on disk in a file the user syncs and
shares, which is the worse of the two leaks.

Both tools refuse the same predicate, defined once as `looksSecret` in `CONTRACTS.md` §3. Refusal is
**silent to the model** in both cases: the call fails as a typed `tool_result`, so probing the filter
teaches an attacker nothing. A guard that is noisy becomes a guard that gets turned off.

### Scope decisions taken 2026-10-03 (round 2)

**D44 — `fs` roots only at a Clauro-owned directory. No chosen-directory root in v1.**
A project never points at a path the user picked. The containment guarantee in D31 is therefore true
on day one, and `fs` remains useful for the things it is actually for in v1 — attachments,
artifacts, and scratch. An `attach` capability (copy a directory in, sync back on demand) is
**designed but not built**; it is the first thing added if `fs` proves too confined. Adding an
escape hatch later is cheap. Retracting a security promise later is not.

**D45 — If WebKitGTK cannot hold an opaque origin, artifacts are disabled at runtime on Linux, with
an in-app notice naming the reason.** One package, and the user is told the truth rather than
wondering why a feature is missing. D2 is never weakened — only withheld, on the one engine where
we cannot prove it holds.

**D46 — `bash` does not inherit the Linux sandbox gate.** The two are separate boundaries: the
artifact frame's safety depends on the webview engine, while `bash` is a host-side capability that is
root-confined and opt-in regardless of engine. Conflating them would disable a useful feature on one
platform for a risk that is not actually shared.

### Compaction accounting, researched 2026-10-03 (round 5)

**D57 — Summary tokens are a separate accounting channel, with a pre-invoke marker.**
`summaryTokens` is never folded into ordinary `tokenCount`. Alongside it we persist
`summaryUsedTokens`: the pre-invoke compacted context size (instructions + summary + kept messages),
or absent when the turn did not summarize. Without this the client re-counts discarded history after a
compact and reports inflated usage — a bug LibreChat hit and documented. It costs roughly thirty
lines of bookkeeping and it is the difference between a usage bar that is true and one that is not.
Counted against `contextBudget`, with `remainingContextTokens` derived from it.

**D58 — Client-side compaction ships in v1 for non-Anthropic providers, using the same two
triggers as D12.** Anthropic keeps the documented server-side path (D14, D15). Everything else gets
the 0.8 / 0.16 pressure trigger plus context-overflow recovery. Chosen over the absolute-reserve form
because the proactive trigger alone has no reactive path: if the ratio estimate is wrong for a given
model, the request simply fails. Having both means a wrong ratio degrades into an extra compaction
rather than a crash.

The prefix-cache replay in D13 only pays off on providers that actually cache. Where they do not, the
same call shape is still correct — it just buys nothing. That is a reason to keep it, not to skip it:
one code path, correct everywhere, cheaper where it can be.

**D59 — LobeHub is observation-only. It is not a source.**
Its licence is the **LobeHub Community License**, Apache-2.0 *plus* the condition that *"a commercial
license must be obtained from the producer if you want to develop and distribute a derivative work
based on LobeChat,"* and that *"the producer can adjust the open-source agreement to be more strict
or relaxed as deemed necessary."* Clauro is intended to be open source, so **no LobeHub code, prompt,
or wording may be copied, adapted, or derived from.** Behaviour may be described as design evidence,
exactly as with the proprietary first-party material. GitHub reports the licence as `NOASSERTION`, so
it must be read rather than trusted — the filename is `LICENSE` with no extension.
Nothing is lost: LobeHub's approach is the weakest of the four implementations for our purposes anyway
(§D60).

**D60 — Only three implementations may be ported: OpenCode (MIT), DeepSeek Harness (MIT), LibreChat
(MIT).** The three were compared on compaction and are the only permissively licensed sources.

| | OpenCode | DeepSeek Harness | LibreChat | LobeHub *(D59 — read only)* |
|---|---|---|---|---|
| Trigger | `context − max(output, buffer)` | **ratio 0.8, tail 0.16** + overflow recovery | **not located** (4 attempts) | turn count, no tokens |
| Checkpoint | fixed-section markdown | markdown + generation proof | **boundary-marked, message sliced from the summary onward** | tagged block in `system` |
| Anti-drift | re-feed prior `recent` | carry-forward instructions | **incremental fold `{summary}`+`{new_lines}`** | none visible |
| Semantics kept as | prose | prose | **structured semantic index** | prose |
| Accounting | inline estimate | dedicated token meter | **separate channel + pre-invoke marker** | none |
| Cache-safe | partly | **yes — trailing user message** | unknown | **no — `system` injection** |
| Usable as a source | ✅ MIT | ✅ MIT | ✅ MIT | ❌ **D59** |

Two things are worth taking from LobeHub **as ideas only**: structural boundary detection via
parent/child maps so a truncation never orphans a tool call from its result (this is the
implementation route to D18), and the observation that its design is the *worst* of the four for a
BYOK client — no token awareness at all, and injecting the summary into `system` breaks prompt-cache
reuse and violates D19.

**D61 — A tool-pairing-balanced boundary is a precondition for summarising, so the compact region is
found structurally *after* measuring.**
> **Corrected 2026-10-03 after audit 2.** D61 previously described DeepSeek as folding
> `tool_call_id` edges structurally *first*. That is wrong on both counts: DeepSeek folds a
> **positional counter** and is **arithmetic-first** — it measures pressure, *then* folds. The
> `tool_call_id`-edge traversal originates in **LobeHub, which is not open source (D59)**. Attributing
> it to DeepSeek both miscredited the source and borrowed an idea from a source we may not port from.

Corrected ordering, which is what DeepSeek actually does:

1. **Measure first.** Compute pressure over the current surface (D64's trigger, token meter only).
2. **Fold second.** Walk back over the message log accumulating tokens until the boundary.
3. **Land only on a balanced boundary.** If the accumulated cut would separate an assistant
   `tool_use` from its result, keep folding until it does not. DeepSeek implements this with a
   positional counter; Clauro may additionally validate pairing by `tool_call_id`, which is a
   property of the wire format rather than a ported algorithm.

Arithmetic decides *where*; structure decides *whether that spot is legal*. Both are required — the
original D61 had them in the wrong order and on the wrong authority.

**D62 — The structured semantic index is deferred to v2.** LibreChat is the only one of the four that
preserves compaction output as revisioned structured entries (`tool_intent`, `tool_outcome`,
`activity_phase`, `reasoning_label`) rather than prose, and no second implementation exists to
validate the schema against. v1 keeps prose. **v2 candidate:** a tightly bounded projection carrying
tool intents and outcomes only, capped entries, revision on overwrite — the one thing prose actually
loses is what the agent was trying to do and what came back.

**D63 — The checkpoint carries a boundary marker and the surface carries a generation counter.**
Resolving a checkpoint **slices the message from the summary marker onward** rather than replacing
the whole row, so parts emitted after a mid-run summary survive. A compaction only counts as real if
the generation counter **advanced** — a summariser that returns success without changing the surface
is not a compaction, and cannot authorise a retry. Two independent MIT implementations: LibreChat for
the boundary, DeepSeek for the proof. Together these make D17's anti-thrash breaker enforceable
rather than heuristic.

---

### Context pressure and abort semantics, decided 2026-10-03 (round 6)

**D64 — The trigger takes the *earlier* of the ratio bound and the usable-context bound.**
> **Superseded by D82.** Kept for history; the arithmetic and the `buffer` value now live in D82.

Clauro fires when **either** bound is crossed. The `min()` is the load-bearing half: it makes the
trigger self-correcting per model, so a large output reservation automatically compacts earlier.
**Corrects D58**, which adopted the bare 0.8.

### Compaction arithmetic, corrected after audit 4

**D82 — The trigger is floored, and every reserve term is proportional to the window.**
> **Supersedes D64's arithmetic.** Audits 3 and 4 found the same defect from two directions: with the
> spec's own constants the trigger went **negative** on every model below an 85,536-token window —
> the entire local-model class the OpenAI-compatible adapter targets. `buffer` had no Clauro value at
> all, and `Tasks/015`'s test table asserted numbers that did not follow from its own formula.

**Corrected 2026-10-03 by external audit.** Three defects, all confirmed by recomputation:

1. `maxOutputTokens` is the **model's** ceiling, not what the request asks for. Reserving the model's
   128,000 on a 200,000 window yields a trigger of 50,000 when the request set `max_tokens: 8,000` and
   the true trigger is 130,000 — an 80,000-token error driven by a field we never bound.
2. The 2,048 floor sits **below fixed overhead**. On an 8,192-token model, the system prompt plus
   eight tool schemas is roughly 6,000 tokens, so a trigger of 2,048 is permanently exceeded and
   compacts **every turn**.
3. "Zero negative triggers" was **near-vacuous**: `max(2_048, …)` cannot produce a negative result, so
   the sweep proved a property the `max` had already guaranteed. The assertion needed to be about
   usefulness, not positivity.

```
headroom    = min(headroomIn, 65_536, 0.25 × contextWindow)
reserved    = min(max(requestMaxTokens, 20_000), 0.50 × contextWindow)
fixedCost   = systemTokens + Σ toolSchemaTokens + 512
ratioBound  = 0.8 × contextWindow
usableBound = contextWindow − reserved − headroom
trigger     = max(fixedCost + 2_048, min(ratioBound, usableBound))
```

`requestMaxTokens` is the `max_tokens` on **this** request, defaulted to the model's ceiling only when
the request does not set one. Reserving what we will actually ask for is the whole point — the
reserve exists so the reply has room, and a reply capped at 8,000 needs 8,000 of headroom, not 128,000.

The floor becomes `fixedCost + 2_048` rather than a constant. A trigger must be *above* the cost of
sending the request at all, or compaction fires before the first token of real content. `fixedCost` is
measured, not guessed: the token meter counts the system prompt and the serialised tool schemas, plus
512 for envelope overhead. This is the assertion that replaces the vacuous negativity check — if
`trigger ≤ fixedCost`, the model compacts every turn forever.

The proportional caps still do their original job. On a 1M-window model they never bind and the ratio
bound wins at 800,000, so D64's original reasoning stands. On a 32k model they bind hard, which is
correct: reserving 20,000 of a 32,000 window would fire compaction almost immediately.

**D83 — The artifact CSP is closed by default, not by enumeration.**

D3 set `connect-src 'none'` and stopped there. Audit 4 finding 8 showed that closes `fetch` and
nothing else: an artifact could still load a remote `<script src>` and embed a remote `<iframe>`.
Two independent reasons that matters. `connect-src` governs `fetch`/XHR/WebSocket only, never
`<script src>` or `<iframe src>`. And `sandbox` **does not inherit into nested browsing contexts**,
so a frame an artifact creates is not sandboxed by the parent's attribute — CSP is the only control
left on that path.

Per CSP Level 3, `default-src` is the fallback for every fetch directive **that is absent**,
including `script-src`, `frame-src`, `child-src`, `worker-src` and `object-src`. So the policy is
stated as a default and opened only where artifacts genuinely need:

```
default-src    'none'
script-src     'unsafe-inline' 'unsafe-eval' data: blob:   ; Sucrase output is inline + eval'd
style-src      'unsafe-inline' data: blob:
img-src        data: blob:
font-src       data:
frame-src      'none'      ; the hole audit 4 named
child-src      'none'      ; older alias, some engines read this one
object-src     'none'
worker-src     blob:       ; our own transform Worker, nothing remote
media-src      data: blob:
connect-src    'none'      ; unchanged from D3
form-action    'none'
base-uri       'none'
frame-ancestors 'self'   ; NOTE: ignored in a <meta> CSP (D93)
```

`'unsafe-inline'` and `'unsafe-eval'` are required and are scoped by the opaque origin, which is why
D2 remains load-bearing even with an incomplete script policy. They are safe here precisely because
the frame is not same-origin and cannot reach the host.

**One renderer-specific trap:** with `default-src 'none'`, Firefox blocks *external* SVG sprites
referenced by `<use href="...#id">` where Chromium allows them. Artifacts must inline their SVG
symbols rather than reference an external sprite file, or icons silently vanish on one engine.

**D84 — The surface is derived from a compaction ledger. Compaction never deletes.**

CONTRACTS.md §1 forbade `UPDATE` on `message`/`block` and forbade `DELETE` by implication, yet D19's
prefix guarantee and D63's generation proof both assume a compaction removes a run. Audit 4 findings
G1–G3: **the storage layer could not express the thing the correctness argument rests on.**

A compaction writes a row and nothing else. Rows are never removed; they are *superseded*, and the
surface is a query over the ledger. Two additions:

```sql
-- `message` and `block` declare `generation` inline in CONTRACTS.md §1 DDL.
-- (An earlier draft carried ALTER TABLE ... ADD COLUMN for both; on a fresh
-- database that is a duplicate-column error. Caught by external audit.)

CREATE TABLE compaction_event (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES thread(id),
  generation    INTEGER NOT NULL,     -- strictly +1 per committed compaction (D63)
  summary_block TEXT NOT NULL,        -- the block that carries the checkpoint
  covers_from   INTEGER NOT NULL,     -- inclusive seq, the first row superseded
  covers_to     INTEGER NOT NULL,     -- inclusive seq, the last row superseded
  summary_tokens   INTEGER NOT NULL DEFAULT 0,   -- D57's separate channel
  summary_used_tokens INTEGER,                    -- D57's pre-invoke marker
  created_at    INTEGER NOT NULL,
  UNIQUE (thread_id, generation)
);
```

The surface is therefore: the highest-generation `compaction_event`, its `summary_block`, and every
row with a **greater** `seq` than `covers_to`. Older rows stay on disk — which is also what makes
D19's "never re-send a removed block" auditable: the row that was superseded is still there to check
against. It also means "delete every byte" (`Tasks/019`) is a real `DELETE` at the storage layer and
is the *only* place it happens, which is why that task tests the filesystem and not a mock.

| contextWindow | maxOutput | headroomIn | reserved | headroom | ratioBound | usableBound | **trigger** |
|---|---|---|---|---|---|---|---|
| 200,000 | 128,000 | 65,536 | 100,000 | 50,000 | 160,000 | 50,000 | **50,000** |
| 200,000 | 8,000 | 65,536 | 20,000 | 50,000 | 160,000 | 130,000 | **130,000** |
| 1,000,000 | 128,000 | 65,536 | 128,000 | 65,536 | 800,000 | 806,464 | **800,000** |
| 32,000 | 4,096 | 0 | 16,000 | 0 | 25,600 | 16,000 | **16,000** |
| 8,192 | 2,048 | 0 | 4,096 | 0 | 6,553 | 4,096 | **4,096** |
| 16,000 | 4,096 | 65,536 | 8,000 | 4,000 | 12,800 | 4,000 | **4,000** |

Verified by exhaustive sweep: windows 4,096 → 1,048,576 × five output sizes (2,048 / 4,096 / 8,192 /
32,768 / 131,072) → **zero negative triggers**. The table is generated from the formula, not typed by
hand; `Tasks/015` regenerates it in its own test and fails if the two disagree.

The last two rows are the ones the old table was hiding. A local 8k model and a 16k model with an
oversized headroom both previously produced a trigger at or below zero.

**D85 — The turn loop and the system prompt are a contract, and they own a task.**

Nothing in the suite defined *how a turn actually runs*: who dispatches a `tool_use`, in what order,
what re-enters the request, when the loop stops, and what the system prompt is. `Tasks/007` owns the
registry and permissions; no task owned the loop that drives it. The system prompt was worse — it is
frozen per thread (**D19**) and every tool's behaviour depends on it, yet it had no shape, no owner
and no test. Audit 4 finding 6.

Three parts, one owner:

**The loop.** Stream the response. On `tool_use`, dispatch through the registry, bound the output on
the way out (**D27**), append the result, and re-send. Repeat until the assistant returns no
`tool_use`, or the user stops. Serial dispatch only — v1 has no parallel calls, which is the single
thing v2's general tool loop adds. Every dispatched call gets a result, including a cancelled one
(**D65**), and a turn that stops mid-call keeps its completed work (**D68**). Nothing throws across
the boundary (**D55**); a handler that cannot proceed returns a typed error and the model decides.

**The system prompt.** Assembled once at the thread's first turn, hashed into
`thread.system_frozen` (**D19**), and never rebuilt. It states the tool inventory, the `fs`
preconditions, the output-bounding behaviour, and the memory protocol instruction Clauro writes
itself (**D7**, **D11**) — **our wording, never first-party text** (**D39**). Because it is frozen,
anything that would vary per turn does not belong in it: thinking effort, `max_tokens`,
`tool_choice` and `metadata` are per-request parameters (**D76**), not prompt content.

**The stop conditions.** `end_turn` · `max_turns` · the user stopping · transport failure. No
budget cap in v1, because there is no general loop to bound and the context trigger (**D82**) is the
real ceiling.

`Tasks/023` owns all three and asserts them without a provider: the loop runs to
`end_turn` on a fixture that emits two `tool_use` blocks; a cancelled turn closes both calls
(**D65**); the prompt hash is stable across turns and changes when the tool list does (**D19**,
**D67**); and a prompt containing first-party wording fails a test (**D39**).

**D65 — Every dispatched tool call gets a result, including cancelled ones.** If the user stops
mid-turn after assistant `tool_use` blocks are durable but before all of them have dispatched, each
undispatched call is closed with an aborted `tool_result`. An orphaned call with no result is exactly
the unbalanced pair D18 and D61 exist to prevent, and it only surfaces after compaction or on resume.
Ported from DeepSeek's recovery path.

**D66 — Every `bash` command requires explicit per-invocation approval. Nothing is persisted.**
No trust-on-first-use, no seeded allowlist, no remembered prefix. The dialog shows the exact command
and its working directory; approve or reject; the outcome is an ordinary `tool_result`. The cost is
that repeat commands keep interrupting. That cost is the feature: a persisted allowlist would let a
prompt-injected model run unattended inside the session workspace, which would quietly break the
zero-telemetry trust claim that the rest of the product is built on. **No yolo in v1.**

**D67 — Opting into `bash` for a project also opens a fresh thread.** ~~Superseded on the Claude
API by `D94`; retained for the OpenAI-compatible adapter.~~ The tool list is fixed for the life of a
thread on that adapter, so an already-running thread cannot gain `bash` — and neither can one started
after the user opts *out*. Enabling it is therefore per-project, effectively permanent, and invisible
to existing threads. Without this, the failure mode is a silent no-op: the user opts in, asks for a
command, and nothing happens for no visible reason. The opt-in action carries the note.

> **On the Claude API this decision no longer applies and the behaviour it worked around is gone.**
> `bash` is declared on the first request with `defer_loading: true` and handed to the model with a
> `tool_addition` block the moment the project opts in (`D94`), so the open thread gains it and the
> opt-out path works too. The two adapters therefore behave **differently on purpose**, and both are
> tested. `project.bash_enabled` and the per-invocation consent (`D66`) are unchanged and apply to
> both.

**D68 — A turn that stops mid-tool-call keeps the completed work.** The partial assistant turn and
all closed tool results stay in the append-only log. Rolling the turn back would lose work the model
already did and would contradict D65, which keeps results we did get.

### Scope decisions taken 2026-10-03 (round 3)

**D47 — Attachments live on disk. Their content never goes into context automatically.**
An upload is copied into the session workspace and the model receives only a path, size, and type. It
reads the file through `fs` when it decides it needs the content. This is the single biggest token
lever in v1: inlining attachments makes cost quadratic in thread length and inflates the 0.8
compaction trigger until compaction fires constantly. It also makes D44's containment story the
reason attachments are cheap rather than a limitation.

**D48 — Two provider adapters ship: Anthropic, and one OpenAI-compatible adapter for everything
else.** *Risk, recorded deliberately:* the OpenAI-compatible surface is validated against a
third-party server, so its coverage of real providers is an assumption, not a test. The dialect has
documented variation in streaming deltas, tool-call framing, and reasoning-token fields. **The
adapter must degrade visibly** — if a provider's stream does not match expectations, say so in the
transcript rather than rendering a plausible-looking transcript that is wrong.

**D49 — Windows uses the evergreen WebView2 bootstrapper.** Keeps the install small and the runtime
current. Known consequence: the bootstrapper needs network access on first run, which fails on the
locked-down machines where a local-first tool is most attractive. See the open question on
detecting that.

**D50 — Linux support floor is the oldest LTS tier with WebKitGTK 2.40 or newer.** *(Secondary platform as of **D89**; the floor is no longer the primary release gate.)* Chosen
conservatively and deliberately: D45 depends on WebKitGTK sandbox behaviour being *consistent across
the supported range*, so the floor is a testable envelope rather than "whatever builds". Distro-native
packaging differs from Cargo sys-crate builds, so the CI matrix — not the floor statement — is the
real contract.

### Scope decisions taken 2026-10-03 (round 4)

**D51 — Clauro defines its own `memory` tool and uses it on every provider, Anthropic included.**
`memory_20250818` is an Anthropic-provided tool type that does not exist elsewhere, so shipping it as
ours is what makes memory provider-independent rather than an Anthropic-only feature. *Cost,
recorded knowingly:* we give up the API's auto-injected memory protocol on Anthropic and must write
the equivalent ourselves. That is the same trade already accepted for `artifact` in D1, and it means
one memory code path and one test surface instead of two diverging ones.

**D52 — Attachment dedupe is per project.** One copy per project, shared across that project's
sessions, never across projects. Global content-addressing is cheaper on disk but would make one
project observable referencing a file another project supplied, which is a privacy cost for a saving
that is negligible at chat-client volumes.

**D53 — A missing WebView2 runtime is detected and explained before first paint.** Never a blank
window and never a bare crash. The message states what is missing, why the app cannot start, and how
to obtain it. D49's network dependency is a known cost of the small download; this is the mitigation.

**D54 — Reasoning renders as a collapsible inline region with one unified shape.** Anthropic thinking
blocks and OpenAI reasoning tokens normalise to a single `Thinking` shape and render as one
collapsible inline region per turn. A separate reasoning pane was **rejected** — it competes with the
artifact drawer for the same screen space, and the two would fight for attention during exactly the
turns where both matter.

**D55 — Tool failure is always recoverable, and the model decides what happens next.** Any failure
returns a typed error `tool_result`; nothing throws across the tool boundary and nothing dies. A
non-zero exit code is a **result, not a failure** — the model sees the output and the status and
decides. This is what makes D40 work: a `question` answer, a rejected `bash` command, and a missing
file all travel the same path and all survive compaction unchanged.

**D56 — Transport-level retry with backoff for 429 and 5xx, respecting `Retry-After`.** Implemented
in the transport layer with **no agent-level retry concept**. The loop does not know retries exist;
it only ever sees a request fail or a stream arrive. This keeps D56 out of the way of v2's general
tool loop, which brings its own retry and budget caps for tool calls — two layers, two concerns.

---

### Audit corrections 2026-10-03 — workflow vs online docs

Audit: `.agents/research/audit/01-workflow-vs-docs.md` — 45 confirmed, 3 contradicted, 8 unverified,
18 omitted claims, 12 sources (Anthropic docs, Tauri v2, WHATWG/W3C, MDN, MS Learn, WebKit Bugzilla,
GNOME libsecret).

Three contradictions fixed inline: **D2** causation, **D20** nesting, **D21** mutual exclusion. The
omissions became decisions:

**D69 — The compaction swap protocol is strict and fails silently.** The compaction response is a new
content-block type `compaction` with `stop_reason: "compaction"`. Streamed, it arrives as **one
`content_block_start` + `content_block_stop` with no deltas at all**. On send-back: the block goes
**first** in `messages`, the messages it summarises **must be removed** (otherwise
`compaction_block_misplaced`, a 400), and there may be **exactly one** block per request. **Two of
the three failure modes raise no error whatsoever** — a client that does not validate the invariants
will corrupt its own thread silently.

**D70 — Post-compaction usage must come from `usage.iterations`, not the top-level token fields.**
**Corrected 2026-10-04 by external audit: the zeroing is not universal.** It holds for a response
whose iterations are *only* compaction. Under **threshold** compaction the top-level fields cover the
non-compaction iterations of that request, so they are non-zero and silently mean something
different from the on-demand case. **Sum `usage.iterations` for billing; take the last iteration for
context size.** Never read a top-level field for either purpose. (Original wording: after a compaction
response the top-level `input_tokens` and `output_tokens` are **zero**. Any usage
footer reading those fields shows 0/0. This is the same trap as D57 from the other direction: there,
summary tokens were folded into the wrong channel; here, the real cost is in a channel nobody reads.

**D71 — `input_transformations` is the only runtime signal that thinking blocks were dropped.** It
arrives on `message_start` when streaming, and again on the final `message_delta` after a server-side
fallback. D20 sends `drop_block` on every request, so Clauro will cause drops — and this is the only
way to observe them. Without it the UI silently claims an intact history it does not have.

**D72 — Capture `signature_delta`, and treat thinking as an unbroken run.** A `signature_delta` is
sent just before `content_block_stop` for **every** thinking block; a persister that stops at
`content_block_stop` without it will replay thinking blocks that fail verification. Separately,
thinking blocks must form an **unbroken run** — removing one from the *middle* invalidates every
later block, which is a stricter rule than "never re-send a removed block".

**D73 — Handle `thinking.display: "omitted"`.** It opens a thinking block, sends exactly one
**empty** `thinking_delta`, then a single `signature_delta`, then closes. D54's collapsed renderer
must treat that as a valid thinking block, not a malformed one. This is on the v1 thinking-effort
path, so it is not hypothetical.

**D74 — Compaction requests have their own parameter constraints.** They reject `stop_sequences`,
`output_config.format`, and a `tool_choice` of type `any`/`tool`; a trailing unresolved tool call is
also a 400; and `max_tokens` must leave room for several thousand. The compaction request builder is
therefore a separate builder, not a flag on the normal one (see D21).

**D75 — Availability of on-demand compaction is checkable at runtime.** The Models API exposes
`capabilities.compaction`. **This closes open question #11** — the plan gate no longer needs a live
key, because the app can ask. On-demand compaction also accepts an `instructions` string of up to
**16,384 characters** that replaces the default summariser prompt, which is how a BYOK client supplies
its own checkpoint format (D16) to the server-side path.

**D76 — Thinking effort may vary mid-thread.** `effort`, `max_tokens`, `output_config`, `tool_choice`,
`metadata`, `thinking.display`, and `cache_control` markers are explicitly **not** part of the prefix
check. So D19's fixed-thread rule constrains `system` and `tools` only — the effort slider can move
during a conversation without invalidating anything.

**D77 — `freezePrototype` does not harden the artifact frame.** It runs as an initialization script on
every Tauri **webview**; a `srcdoc` iframe is not a webview and is not covered. Do not count it toward
artifact-frame hardening.

**D78 — `dangerousDisableAssetCspModification` accepts a list of strings, not only a boolean.** A list
disables Tauri's injection for only the named directives. That is a strictly better answer than
skipping the knob, and better than the boolean form which disables it app-wide.

**D79 — The Windows reserved-name list is longer than four names.** Also `AUX`, `COM2`–`COM9`,
`COM¹`/`COM²`/`COM³`, `LPT1`–`LPT9`, `LPT¹`/`LPT²`/`LPT³` — and `NUL.txt` is equivalent to `NUL`.
`MAX_PATH` is additionally **opt-out** (removable since Windows 10 1607 via registry or Group Policy,
and bypassable with the `\\?\` prefix), so the 260 budget is a conservative design target rather than
a hard limit.

### Streaming and context-management gaps, closed 2026-10-03 (round 8, audit follow-up)

**D80 — The SSE parser has an explicit unknown-event branch.** `ping` is a keepalive. `error`
terminates the stream with a typed error surfaced in the transcript. **Anything unrecognised is
ignored, not fatal.** Anthropic's own guidance: *"your code should handle unknown event types
gracefully."* A hand-rolled parser (D24) that assumes it knows the full event set breaks the first
time a new event ships. It must fail **open on the stream** — ignore the event, keep reading — and
**closed on the transcript**, never rendering a partial or misordered turn as complete.

**D81 — Threshold compaction is a third server-side strategy, and the simplest one.** ~~The
*preference* here is superseded by `D95`: on-demand is primary, threshold is the fallback. The
strategy itself and everything below still stand.~~ The `compact_20260112` context-management edit
puts compaction on **ordinary requests**: one parameter, the API decides when, no separate request
builder. It remains the right answer where on-demand is unavailable, because it removes D74's entire
constraint set (`stop_sequences` rejected,
`output_config.format` rejected, `tool_choice` `any`/`tool` rejected, a trailing unresolved tool call
is a 400, `max_tokens` must leave room) along with D21's request branch and D69's strict swap
protocol with its two silent failure modes. On-demand compaction (D14) stays for the explicit
`/compact` command and for supplying our own `instructions` up to 16,384 characters (D75). Where
neither is available, the client-side path (D58) applies. Availability is checkable at runtime via
`capabilities.compaction` (D75), so the branch is decidable per model rather than a guess.

---

## Audit corrections 2026-10-04 (audit 3 M13, audit 4 follow-up)

**D86 — `clear_at_least` gets a value, a field, and a test.**
`D22` said "set `clear_at_least` meaningfully high" with no number, so it was unactionable and
untestable — audit 3 caught it as a decision cited by a task that no test could pin. The reasoning:
clearing a tool result **invalidates the cached prompt prefix**, so each clear costs a cache-write. A
clear too small to repay that write is a net loss on both cost and latency. Floor-plus-proportional,
the same shape as `D82`, so it self-corrects per model instead of being tuned by hand:

```
clearAtLeast = min(5_000, 0.02 × contextWindow)
```

**Corrected 2026-10-03 by external audit.** The original form was `max(5_000, 0.02 × contextWindow)`
with a guard asserting `clearAtLeast ≤ 0.05 × contextWindow`. That guard **failed on three of its own
five table rows**: at a 32,000-token window the formula yields 5,000 while `0.05 × window` is 1,600;
at 16,000 it is 800; at 8,192 it is 409. A test that disproves its own table is worse than no test,
because it trains the reader to distrust the number next to it.

The correction is to cap rather than floor. The floor was the error: a 5,000-token absolute minimum
is simply too large for a small-context model, where clearing a quarter of the window to save a
cache-write is the wrong trade in the opposite direction. Capping keeps the value proportional on
small models and still reaches the documented 5,000 on any model with ≥250,000 tokens of context,
which is the regime the first-party worked example actually describes.

Field name in the request builder: `contextManagement.clearAtLeast.inputTokens`. Sent **only** on a
request that also carries `clear_tool_uses_20250919` — it is a field of that strategy, not a
top-level knob.

| contextWindow | clearAtLeast | 0.05 × contextWindow | guard |
|---|---|---|---|
| 1,000,000 | 5,000 | 50,000 | pass |
| 200,000 | 4,000 | 10,000 | pass |
| 32,000 | 640 | 1,600 | pass |
| 16,000 | 320 | 800 | pass |
| 8,192 | 163 | 409 | pass |

Test: for each row, recompute from the formula and fail if the builder disagrees; additionally fail
if `clearAtLeast > 0.05 × contextWindow`. Because the formula now caps at the proportional term, the
guard holds by construction rather than by luck — assert both anyway, since the whole point of this
correction is that a plausible-looking formula and a plausible-looking guard can disagree.

This is the only strategy where *more* clearing is not automatically better, so the guard runs the
other way from `D82`'s.

**Also closed by this block:** `M10` and `M11` were fixed in `CONTRACTS.md` (§ `looksSecret`, and the
qualified cold-start criterion); `M12` in `DESIGN.md` (a compaction inserts a `summary`, not a
`notice` — `D84`).

**D87 — `SPEC.md` and `ARCHITECTURE.md` join the authority order, and `SPEC.md` becomes the single
normative source of v1 scope.** Two documents existed as pure restatements of things decided
elsewhere, and audits found them drifting: *what is in v1* was stated independently in `DECISIONS.md`
§3, `ROADMAP.md`, `CONTRACTS.md` §6 and `PHASES.md`, which is how audit 3's M2 and M9 arose — a
feature declared in one place and owned by no task in another. *How the pieces relate* was scattered
across `DECISIONS.md` §2, `CONTRACTS.md` and `TECH_STACK.md` §2.

The order becomes:

```
MISSION      what this is, and what it is not          → does a feature belong?
SPEC         what must exist, with acceptance criteria → does it exist, fully?
DECISIONS    why each non-obvious choice was made      → why this way?
CONTRACTS    the shapes tests assert against            → what does it look like?
ARCHITECTURE how the pieces relate and where deps point → does it fit together?
DESIGN       how it feels and behaves                   → what does it look like to use?
```

`SPEC.md` is **normative** and the other three become **derived** — where they disagree, `SPEC.md`
wins and the derived copy is a bug. `ARCHITECTURE.md` owns the crate graph, the turn loop, the
surface-derivation rule and the two security boundaries, and `DECISIONS.md` §2 and `TECH_STACK.md`
§2 become pointers.

Neither document may mint a decision. Any genuinely new decision gets a D-number in `DECISIONS.md`
and is cited from the two new documents, so the record stays single-sourced. Both are **derived and
verifiable**, not new judgement: everything in them already exists as a D-number, a contract, or a
task, and a citation that cannot be resolved is a defect in that file.

---

### Platform and build topology, decided 2026-10-03 (round 9)

**D88 — Windows is the primary build-and-test platform, and development happens natively on
Windows.** Superseding the earlier WSL-invocation arrangement in the same round: the repo now lives
on the Windows filesystem, builds with the Windows toolchain in a Windows shell, and needs no
interoperability layer at all.

Verified end-to-end: Windows `rustc` on `x86_64-pc-windows-msvc`, MSVC Build Tools `link.exe`,
Windows SDK `10.0.26100.0`, and a trivial binary compiled, linked and executed. **The concrete
install paths and build numbers belong to whichever machine you are on and are not recorded here** —
a spec that carries a `C:\Program Files\…` path is wrong the moment anyone else clones it.

There is no cross-compilation step, because there are no two toolchains to bridge.

**D89 — The artifact sandbox release gate is platform-scoped. WebView2 must pass; WebKitGTK is
best-effort.** Windows is the primary platform, so the WebView2 half of `Tasks/001` is the one that
gates a Windows release. If WebKitGTK cannot hold an opaque origin, Linux ships with artifacts
disabled at runtime (`D45`) — a **Linux** limitation that no longer blocks a Windows release. D45 is
unchanged and D2 is never weakened; only the *consequence* of a WebKitGTK failure is rescoped.

This is the correction audit 4 asked for by implication: `SPEC.md` §1 previously listed both platforms
as co-equal without saying which one gates a release. It does now.

## Audit corrections 2026-10-04 (external audit, `~/Downloads/clauro-audit-fixlist.md`)

**D90 — The network claim is narrowed to what CSP actually proves, and the gaps get probes.**
MISSION claim 3 ("no network egress") cannot be delivered by CSP alone. WebRTC data channels bypass
`connect-src` and no browser ships a `webrtc` CSP directive, so there is no policy that closes them.
`dns-prefetch` leaks and is not gated by our directives. Self-navigation (`location =`, meta refresh)
may escape the document policy. `window.open` is governed by `sandbox`, not CSP.

**The decision is to say less rather than to add a guard.** Removing `RTCPeerConnection` from the
frame would restore the broad claim, but deleting a global from a frame is itself error-prone, and a
claim that survives only because we patched one symbol is a claim one missed symbol undoes. So `D3`
and MISSION now state what CSP proves: no `fetch`/XHR/WebSocket, no remote script, image, font or
frame, no form post, no popup. `Tasks/001` and `Tasks/014` carry a probe for each bypass on both
engines. If a probe shows a real leak the fix is a sandbox token, not a quieter claim.

**D91 — `event.origin` is validated on the handshake only; the port is the capability thereafter.**
External audit found `D6`/`A5` unimplementable as written. Per the HTML spec, a message delivered on a
`MessagePort` has an **empty `origin` and a null `source`** — there is no meaningful value to compare
on every message, so "validate `event.origin` and `event.source` on every message, both directions"
describes an operation that cannot be performed.

The correct shape, and the reason `MessageChannel` was chosen over raw `postMessage` in the first
place: validate **once**, at the handshake, that `event.source === iframe.contentWindow` and that the
origin is the expected opaque `"null"`, then transfer `port2`. From then on the port reference *is*
the capability — it never appears in a global, it is unreachable from other documents, and it closes
automatically if the frame navigates away. Every later message is checked against the message
allowlist, not against an origin.

**D92 — The sandbox probe asserts on effect, and Tauri is pinned above CVE-2024-35222.**
The sixth probe asserted `window.__TAURI_INTERNALS__ === undefined`, which is not a test of the thing
that went wrong. CVE-2024-35222 was iframes **reaching** Tauri IPC; the fix stopped injecting the IPC
script into iframes except on Windows when origins match. A global being undefined says nothing about
whether a privileged command executes.

So the probe attempts `invoke(...)`, `__TAURI_INTERNALS__.postMessage(...)`, `window.ipc.postMessage`
and `window.chrome.webview.postMessage` from inside the frame, against a host command that writes a
sentinel file. The assertion is that the file does not exist afterwards. Absence of a global is a
weaker fact than absence of an effect, and the effect is what the advisory was about.

`D2`'s premise — *"Tauri gates commands by capability and scope, not by caller origin"* — is **dated**
by that fix and is no longer the whole story: the current guarantee is that the IPC script is not
injected into child frames at all, plus our own `sandbox` attribute. `Tasks/001` therefore pins the
exact Tauri version and records it in the verdict file. If a future Tauri release changes the
injection rule, the probe catches it before we ship.

**D93 — `frame-ancestors` is dropped from the artifact CSP, because a `<meta>` cannot deliver it.**
External audit: per CSP Level 3, `frame-ancestors` is **ignored** when the policy arrives in a
`<meta>` element — only an HTTP header can carry it. We deliver the artifact policy in a `<meta>`
inside the `srcdoc`, so listing `frame-ancestors` there is a line that reads as protection and is not.

The Chromium-only `iframe csp` attribute is the one alternative, and we are not using it: it would
split behaviour between WebView2 and WebKitGTK, and `D89` already makes that split a release gate we
cannot afford to widen.

`frame-ancestors` is not needed here anyway. It restricts who may **embed** our document; the artifact
document is embedded by us, in a frame we created, from a `srcdoc` we authored. The threat we care
about is the artifact escaping *outward*, which `default-src`/`connect-src`/`sandbox` cover.

## Audit corrections 2026-10-04 — verified against primary docs

**D94 — D19/D67 are superseded on the Claude API by `tool_addition`/`tool_removal`.**
Verified on `platform.claude.com/docs/en/build-with-claude/preserved-thinking`. Beta header
**`inline-tools-2026-09-15`**, Claude API only; add `mcp-client-2026-09-15` when the tool comes from an
MCP server reached through the MCP connector. The older `mid-conversation-tool-changes-2026-07-01`
works on the Claude API, Amazon Bedrock and Google Cloud but only for changes that name a tool *by
reference*.

Verbatim: *"Editing the tools array mid-session invalidates preserved thinking blocks. Leave the array
as you first sent it, and change which tools the model can use by appending a `role: "system"` message
that carries `tool_addition` or `tool_removal` blocks."*

**`defer_loading: true` is the primitive that makes this work.** Verbatim: *"Declare every tool up
front. Put every tool the session might need in `tools` on the first request, with `defer_loading:
true` on any the model shouldn't see yet. Then turn tools on and off with `tool_addition` and
`tool_removal` blocks that name them."* And: *"the prefix check ignores a deferred tool until a
`tool_addition` block references it. Adding a tool without `defer_loading: true` changes the prefix
and invalidates earlier thinking."*

**So D67 is wrong on the Claude API.** "Enabling `bash` opens a fresh thread" was a consequence of
D19's frozen-tools rule, and D19's rule is exactly what this supersedes. The correct shape is: declare
all eight tools on the first request, mark the not-yet-available ones `defer_loading: true`, and let
per-thread permission state select which are `tool_addition`-ed. **No fresh thread, and no per-thread
`tools_frozen` hash.** `D76`'s claim that thinking effort may vary mid-thread is confirmed by the same
page: top-level `output_config.effort` *"restarts the cache, doesn't affect thinking."*

**The constraint that remains, and it is new.** Verbatim: *"The `role: "system"` messages that carry
these blocks join the prefix for later thinking, so don't move, reword, or delete them afterward."* The
tool-change messages are themselves **append-only** — they enter the prefix retroactively. That is
consistent with `D19`'s append-only discipline, so it survives; the frozen-`tools` half does not.

**Fallback, and it is the honest one.** Mid-conversation system messages and tool changes are **not
available on every model**. Verbatim: *"If your code serves several models, keep editing the top-level
system prompt for the models that don't accept them."* So frozen `tools` is not deleted, it is
**demoted to the non-Anthropic path** — which is the whole second adapter (`D48`). Anthropic gets
`defer_loading` plus `tool_addition`; the OpenAI-compatible adapter gets the frozen array it needs
anyway. Both paths are tested; neither is the default for both.

**D95 — on-demand compaction is primary, threshold is the fallback.**
Verified verbatim on `platform.claude.com/docs/en/build-with-claude/compaction`: *"Use on-demand
compaction wherever it is available"* and *"Compaction on demand covers more common use cases."* The
docs also state that on-demand *"Runs in the background: Yes"*, whereas threshold *"runs inside the
request that reaches the trigger."* **D81 is superseded.** My reasoning for preferring threshold — no
separate request builder, no `D74` reject set, no `D69` swap protocol — optimised for the least work
in our client rather than for what the user experiences. It also gave away the two things on-demand
uniquely offers and that `D16` actually wanted: keep-recent-turns, and our own `instructions`
(up to 16,384 characters, `D75`) so the checkpoint format is ours.

Threshold is kept, not deleted. It is the fallback where on-demand is unavailable, and the runtime
`capabilities.compaction` probe (`D75`) already decides which is which — so this is a change of
preference inside an existing branch, not new machinery.

**D96 — `lucide-react` is the icon library, app shell only.**

Decided 2026-10-04. `lucide-react` **1.51.0**, ISC, peer-declares React `^19`. Every icon is an
inline `<svg>` and the package is fully tree-shakable ES modules — named imports only, the full set
never reaches the bundle. Alternatives rejected and recorded in `TECH_STACK.md` §6:
`react-icons` (per-set bundle analysis, brand logos return), `@radix-ui/react-icons` (fifteen
icons), `feather-icons` (last released 2024-05-01, the abandoned original Lucide forked from),
`material-symbols` (13 MB icon font, wrong delivery mechanism), `@mui/icons-material` (hard peer on
`@mui/material`).

Scope is the app shell: chat affordances, the incognito ghost (**D37**), the crossed-out memory
indicator (**D9**), the command palette. **Artifacts are excluded in v1.** They run in an opaque
origin with no network (`D2`, `D3`), so they cannot import from `node_modules`, and an external SVG
sprite is already known to break on WebKit under `default-src 'none'`. When artifacts get icons
(v2), they are inlined SVG paths with their own task and vendoring step.

**D97 — `reqwest-sse` is recorded and not adopted; hand-rolled SSE stands.**

Decided 2026-10-04. `TECH_STACK.md` §3 previously claimed both SSE crates were unmaintained. That
became false: `reqwest-sse` 0.2.0 released 2026-05-08, MIT, maintained. It is the honest alternative
and is recorded in §3.1 rather than dismissed. It is not adopted: it covers only the framing layer,
while `CONTRACTS.md` §5's four rules are Anthropic event *semantics* we own either way, each needing
a fixture — and six stars with one maintainer is a supply-chain surface on the most load-bearing
crate in the project. Revisit when it reaches a real release cadence.

**D98 — The composer queues follow-ups sent mid-stream; stop offers drain-or-discard.**

Decided 2026-10-04. Observed behaviour (inspiration only, D103): sending while a turn is
running appends instead of blocking, and stopping aborts the fetch while asking whether the unsent
queue drains or is discarded. Fits serial dispatch (D85): the queue is a per-thread FIFO in the
host, rendered as removable chips, drained in order when the loop goes idle. No parallel calls, no
new block kinds. Owned by `Tasks/023` (loop) with the keep-work half already in `Tasks/006` (D68).

**D99 — Regenerate and edit-resend append new rows; fork copies a prefix into a new thread.**

Decided 2026-10-04. Append-only (D19) already permits a correction as a new row at a higher `seq`;
regenerate-last and edit-resend are that rule applied to the composer — no branching tree, no
sibling navigation. Fork-from-here copies the thread's prefix rows into a new thread under new ids;
the source history is untouched, which keeps the prefix guarantee and the generation counter (D63)
intact. Incognito threads cannot be forked from the UI, for the same reason they cannot be exported
(D37): a fork is a history record. Owned by `Tasks/006` (regenerate) and `Tasks/019` (fork).

**D100 — Transcript HTML is purified before render; streaming markdown parses at most once per frame.**

Decided 2026-10-04. Clauro purifies SVG inside the artifact frame (A6) but left the transcript-HTML
path implicit — observed gap. Behaviour, in our own words: any model or tool HTML reaching the
transcript DOM passes the purifier first; long generations reparse at most once per animation frame;
long code blocks collapse with a hidden-line count. Zero new security surface beyond the existing
purifier. Owned by `Tasks/006`.

**D101 — A second `question` call in one assistant turn is refused as a typed `tool_result`.**

Decided 2026-10-04. C8 caps one question per turn but left the mixed-call hole: a turn calling
`question` alongside another tool. The host enforces sole-call — `question` must be the only call in
the turn — refused silently like the other question refusals (D43), so the model cannot probe the
guard. Five lines of validation, no new surface. Owned by `Tasks/009`.

**D102 — In-frame navigation is contained: same-origin stays in the frame, external targets blocked.**

Decided 2026-10-04. MISSION already names self-navigation as a probed-not-closed hole (D90).
Behaviour: link clicks inside the artifact frame never escape the frame; same-origin targets are
contained, external targets are dropped with a logged note. Testable alongside the `Tasks/001` and
`Tasks/014` probes; extends A4 without weakening D2. Owned by `Tasks/014`.

**D103 — Open WebUI is observation-only inspiration; nothing is ported from it.**

Decided 2026-10-04. Open WebUI ships under a custom licence with a branding-preservation
requirement, incompatible with Clauro's MIT lineage (SPEC §1). Same rule as LobeHub (D59, D60) and
the same wording bar as first-party material (D39): behaviour may be mirrored with our own
implementation in our own words — no code, no prompt text, no component or class names cross over.
The Rust-vs-web stack makes line-porting moot; the rule stands regardless of stack.

**D104 — Deferred shapes are recorded here, not built; each needs its own task to promote.**

Decided 2026-10-04. Parked with reasons: artifact version stepper + download (v2 — the render must
be trustworthy before history can be pinned); web allow/block lists + fetch caps + truncation
disclosure (v2 tightening of `Tasks/011`); Topics path-group browsing + dedup-on-add + batch ops +
injection budgets (after `Tasks/008` lands); bounded file grep over attachments (v2 `fs`,
`Tasks/010`); system-theme boot without flash (with `Tasks/020`); camera-frame-as-attachment,
cached TTS, single-endpoint STT, image-gen-as-tool (v2/v3 media); parallel multi-model panes +
sibling-branch history (unplanned — needs its own D-number); standalone notes, channels, server
automations, RBAC/SSO, cross-user analytics (never — MISSION is not a hosted service).

**D105 — The queue drains as in-order turns, never merged; chips remove, edit, or send-now.**

Decided 2026-10-04. D98 left drain shape open; the observed merge-into-one alternative changes
meaning (N intents become 1 turn), so this pins it: each queued item dispatches as its own turn, in
order, when the loop goes idle. Queue chips support three ops — remove, edit, send-now (send-now
stops generation without draining, then sends that item). No new block kinds. Owned by `Tasks/023`.

**D106 — A truncated turn resumes via continue-append, not via regenerate.**

Decided 2026-10-04. Observed affordance with an append-only-compatible shape: `continue` flips a
finished-but-truncated assistant message back to unfinished and resumes it, appending to the same
turn. Regenerate stays for redoing a turn; continue is for finishing one. No rewrite, no sibling.
Owned by `Tasks/006`.

**D107 — Scope rows made explicit: calendar, image-gen, standalone notes, eval-arena, video-call.**

Decided 2026-10-04. D104 parked these inside umbrella rows; the audit found each deniable without
its own line, so each gets one in SPEC §5: shared calendar (never — sync/multi-user state; a
pure-local calendar stays unplanned), image-gen-as-tool (v2/v3 media), standalone shared notes
(never — Projects plus memory Topics cover the local need; sharing drags sync back in), eval-arena
and ELO (never — leaderboards need crowds; the local usage footer is the allowed complement),
video-call (never — appended to the voice row). No implementation, only rows.

**D108 — Sandbox and CSP are host-fixed; no runtime code-load or dependency install exists.**

Decided 2026-10-04. The observed failure mode is a user toggle re-adding a sandbox token and an
empty-default CSP string: both void the opaque-origin claim, so no user-facing control may weaken
sandbox tokens or CSP — A1/A3 state this outright. Separately, the observed plugin class (authored
source executed in a fresh namespace, frontmatter shell-installing packages) has no Clauro analog:
the tool set is fixed at eight, nothing loads code at runtime, nothing installs dependencies.
Owned by `Tasks/013`/`014` (fixed flags) and `Tasks/007` (fixed registry).

**D109 — Approval has typed states; served files carry disposition; one writer; ledger over fields.**

Decided 2026-10-04. Four hardening lines from the audit. (1) Ask-mode approval is a typed state
machine — queued, pending, approved, rejected — with resume/drain on approve and a typed `error`
result on reject; tests assert the states, not just that approval exists. Owned by `Tasks/007`.
(2) Served tool-output files use attachment disposition with nosniff for non-media types — an XSS
rule A4/A6/T8 did not state. Owned by `Tasks/010`. (3) Single writer assumed: last-writer-wins
applies to the four mutable tables only; history rows are never merged. (4) Checkpoint state lives
in ledger rows, not message fields — a field is silently overwritable by an upsert path, a row is
not. Both recorded in `CONTRACTS.md` §1.

**D110 — Artifact JSX compiles to a host-owned `h()` that builds DOM nodes. No JS runtime is bundled.**

Decided 2026-10-05 by `Tasks/014`. `D4` settled *that* JSX/TS compiles in-browser with Sucrase and
never said what it compiles **to**. Sucrase is a transform, not a runtime: its `jsx` transform emits
calls to whatever pragma you name. The obvious answer is React, and it is the wrong one here - it puts
~150 KB and a second component model, with its own escaping semantics, inside the one place the
product's security claims live, in exchange for a function that makes one DOM node.

So the frame ships `h(tag, props, ...children)` - twenty-odd lines, written here, building `Node`s
directly. Two consequences, both intended. An artifact's only capability is the DOM it can already
reach, and the prompt can tell the model a plain, checkable thing (`h("div", { class: "p-4" }, ...)`)
instead of a framework's rules. Markup is HTML with `<script type="text/jsx">` blocks, so a purely
static artifact needs **no script at all** - no transform, no timeout, nothing to go wrong.

Rejected: shipping React in the frame (size + a second escaping model inside the boundary); writing
compiled output as a string into the document (no error attribution, and it re-opens the injection
question DOMPurify exists to close); TypeScript-only artifacts (forces JSX authors to learn
`React.createElement` call shapes, which is the thing JSX exists to avoid).

**D111 — The artifact's Tailwind CSS is vendored by `Tasks/022`, not here; `014` owns the constraint,
not the bytes.**

Decided 2026-10-05 by `Tasks/014`. `D5` requires artifacts to use only *predefined* utility classes
and calls that "precisely what makes a no-build-step Tailwind possible inside them" - which is true
only if the CSS actually exists in the frame. It does not yet: the app's own Tailwind build
tree-shakes to the classes `src/` uses, so a utility an artifact asks for may be absent, and an
artifact that renders unstyled looks broken and reads as a sandbox failure.

Deliberately **not** solved here. The bytes are a vendoring and bundle-budget decision, it lands in
`022` alongside the Sucrase budget line that task already owns, and shipping a whole prebuilt
stylesheet is exactly the kind of "looks like diligence, actually inflates the binary" move that
`AGENTS.md` §5a warns against. `014` therefore states the constraint in the system prompt and wires
a stylesheet slot the frame can be given, and leaves the slot empty rather than faking it. Artifacts
render with **no** Tailwind until `022` fills it - visible, honest, and tracked.

**D112 — The frontend is feature-based, and shared UI is vendored shadcn, app-shell only.**

Decided 2026-10-06 by `Tasks/024` (layout) and `Tasks/025` (shadcn). Two halves, one decision:
the flat `src/` that served the Phase-0 shell does not survive Phase-5 surfaces, and hand-rolled
Sidebar/Dialog/Select re-opens the a11y and focus-trap bugs Radix already closed.

*Layout.* `src/features/<name>/` owns logic plus colocated tests, with an `index.ts` barrel;
`src/components/` owns shared UI (`components/ui/` is vendored shadcn, never hand-edited except
to tweak); `src/app/` owns the shell entry (`App.tsx`); `src/lib/` owns `utils.ts` (`cn()`).
`frame-runtime.js` keeps shipping to the sandbox as raw text and never enters the app bundle.
A move is proven by `tsc` clean plus the full vitest suite green with zero behaviour change —
`Tasks/024` moved 31 files and all 95 tests passed untouched.

*shadcn.* Copy, not a package: shadcn is Radix primitives plus `cva`/`clsx`/`tailwind-merge`
pasted into `components/ui/`, so vendoring is the install and tweaking is the point. Pinned
in `TECH_STACK.md` §7.1 with the rejected alternative (hand-rolled dialog/select/sidebar —
a bug farm with a focus trap) and the licence record (all MIT/Apache-2.0). Scope is the app
shell, exactly like `lucide-react` (**D96**): nothing Radix ever enters the artifact frame
(`D2`, `D3`, `D83`), and `components.json` plus the `@/*` alias are config, not surface.
`TECH_STACK.md` §7.2's `cmdk` row is superseded for the palette shell — the Dialog+Command
pair covers **D42**'s palette states — but `cmdk` stays recorded until `Tasks/020` decides.

Rejected: a barrel per component file (indirection with no seam); keeping the flat layout
until Phase 5 (every new surface would invent its own structure); `@radix-ui/react-icons`
(fifteen icons, not a library — decided already in **D96**).

**D113 — The Phase 3 gate e2e proves composition with test-local adapters; no production producer
until a host drives turns.**

Decided 2026-10-06 by `Tasks/028`. The gate clause "artifacts render live" has no producer:
nothing calls `setCompiling`/`setLive` because no tool-result handler exists yet (`src/` was the
Phase-0 shell; `PHASES.md` records the same gap against Phase 2). Adding a production producer
now would repeat the exact trap `AGENTS.md` §7a names — implemented, tested, no caller — so the
e2e wires the composition inside the tests instead: the Rust half drives `artifact` through the
real loop into versioned rows, the frontend half drives a tool result through the real store
actions plus the real `prepareArtifact` into a live render. Each half is production code under
test; only the last-inch driver is test-local, and it is labelled as such.

The same task applies the repo's no-silent-swallow standard to the three `let _ =` drops on the
`D65`/`D68` paths (`run.rs`): a store persist failure returns `LoopError::Store` instead of
vanishing. The turn does not "continue" past a dead store — there is no durable way to record
that it did — so loud failure replaces silent loss, and the task file says so rather than
claiming both.

**D114 — Linux CI is parked until after full development; CI is Windows-only until `021`
re-enables it.**

Decided 2026-10-06 by direct order (no task — this is schedule, not design). Three facts
forced it: Linux matrix jobs never complete (35-minute wall against a 30-minute job limit on
cold builds — no cargo cache is configured and WebKit sys crates compile from scratch);
re-running the same red costs hours and teaches nothing; and every Linux failure so far was
either infra (timeout) or a Windows-reproducible logic bug (pidfile newline, 8.3 names) that
Windows CI plus WSL-native runs already cover. The Linux entries are removed from `ci.yml`,
preserved verbatim in `.github/workflows/linux-matrix.yml.disabled` (a non-`.yml` name GitHub
never executes), and `021` re-enables them together with the cargo cache and timeout budget
that make them meaningful. `D50` is unchanged — a floor failure is still a release blocker —
but an unrun floor blocks nothing; it merely stays open. Windows primary + Windows floor are
the CI gate until then.

**D115 — All Linux work moves to Phase 7 (post-deployment); Phases 0–6 close Windows-only.**

Decided 2026-10-07 by direct order. `D114` parked Linux CI "until 021 re-enables it", but 021
sits inside Phase 6 (Release) — parking release-gate work inside the release phase leaves
every earlier gate honestly open forever, which is how Phases 0–3 stayed ◐ through work that
was actually done. The fix is structural, not semantic: nothing about *what* Linux needs
changes (WebKitGTK verdict in `001`, Linux jobs + floors, Linux gate proof in `021`), only
*when* it gates anything. Phase 7 owns all of it; `D114`'s restore target moves from "`021`"
to "Phase 7". `D45` (runtime gate), `D50` (floor failure blocks release), and `D89` (Linux
secondary, never blocks a Windows release) are untouched — Phase 7 is post-deployment
sequencing, not a scope cut. v1's definition of done (`SPEC.md` §6) reads "both floors" as
the two Windows jobs until Phase 7 lands.

**D116 — The picker shows only configured providers' models; model lists are per-provider with a 3-day TTL.**

Decided 2026-10-07 (task 003/providers). The bulk models.dev fetch showed 200+ providers when
zero keys existed — the overload was never the 5.3 MB, it was showing the whole world. The fix
is gating, not a smaller catalogue: an unconfigured provider has no store row and cannot appear
in the picker. Each configured provider fetches its own live `/models` (Anthropic's with the key
header, OpenAI-compatible with bearer), stored in `provider_model`, refreshed on demand and
stale-flagged past the TTL rather than blocking the picker. Keys live in the keyring under the
provider id — the turn driver already read them that way, so this changes no convention. Picker
gating is PORTED from OpenCode's connected-provider picker; per-endpoint discovery is behaviour
MIRRORED from Open WebUI; keyring storage, the TTL, and lazy enrichment are ORIGINAL. **D103.**

**D117 — models.dev is limits enrichment only, fetched lazily, never at boot.**

Decided 2026-10-07 (task 003/providers). Provider `/models` endpoints report ids, not limits —
Anthropic's returns no context window, OpenAI's returns almost nothing — and the token meter
still needs honest numbers. So models.dev stays, but its role shrinks to enrichment: fetched on
first enriched-models read (7-day TTL, file cache retained), joined per model, and a model it
never heard of carries `limits_known: false` with selection refused rather than zero-guessed
(CONTRACTS.md §5). Boot downloads nothing. Custom-endpoint models stay unselectable until the
live-turn translator carries per-model limits — the request needs them anyway, so that slice
owns them.

**D118 — A sole valid question pauses the turn; the answer is the call's one result; refused questions never pause.**

Decided 2026-10-09 (task 009). Before this, a `question` dispatch persisted an ordinary result and the loop re-sent with the card text echoed back as if answered — the user was never asked. Now the turn ends `AwaitingAnswer` with the `tool_use` plus a `question_card` row and deliberately no `tool_result` yet; answering validates through `resolve_answer` and persists the one result, and the driver resumes. The transiently unpaired `tool_use` is honest, not an I1 violation: I1 pairs exactly once answered, a second answer fails `AlreadyAnswered`, and the pause is visible in the transcript at the point of the question (DESIGN §2.3). Refusals (mixed, second, secret-shaped) keep refusal result rows and never pause — nothing to answer, nothing held. Re-sending an unanswered question is skipped at request build: it would be both malformed (Anthropic requires a result per use) and a lie.

**D119 — The provider row decides the wire; tool results ride the following user message at assembly; the compat translator drops Anthropic-only controls instead of approximating them.**

Decided 2026-10-09 (tasks 005/023 — the OpenAI request translator slice). Three facts, one seam: where a built request goes. (1) `turn_start`/`question_answer` read the provider row and choose the wire **before** any key is read or the thread slot is claimed: Anthropic rows post the body as built to the fixed endpoint; OpenAI-compatible rows post `clauro_transport::openai_request::translate_request`'s body to `{base}/chat/completions` with bearer auth; a compat row with no endpoint URL fails typed (`UnsupportedProvider`) — never a guessed host. (2) The store keeps `tool_result` in the assistant message that held the `tool_use` (D61 pairing is a storage property), but the Messages API takes results back only in a subsequent *user* message and chat-completions needs the same separation to map onto `role: "tool"` — so `assemble_messages` splits them out at assembly time; storage and the transcript never move. (3) The translator **drops** `thinking`, `context_management` and the beta headers rather than approximating them: faking a budget as `reasoning_effort` would be a plausible-looking wrong turn (D48), so the compat wire promises only what every chat-completions endpoint accepts — model, max_tokens, system as the first message, tools with `input_schema` as `parameters`, `tool_choice` as the bare string, `tool_use` as `tool_calls` with JSON-string arguments. Gemini's in-band thought marker (`extra_content.google.thought` over `<thought>` markup, recorded live in Tasks/005) is parsed response-side from the same fixture — reasoning reaches the thinking region on both adapters (D80), never the answer text.

**D120 — The e2e mock is the compat wire's executable witness: it refuses every violation by field name, and the model id picks the script.**

Decided 2026-10-09 (Phase 1–5 completion plan, slice 2; serves the Tasks/005/013/020/021 gates). The e2e must drive real turns without a live key (no test may use a key by rule), and a lenient mock would let a translator or routing regression masquerade as a model answer. So `scripts/mock-openai-server.mjs` — zero dependencies, loopback-only — validates every request against the translated wire (`stream: true`, system-first messages, `tool_calls` arguments parseable JSON *strings*, `function.parameters` never `input_schema`, bearer auth, and no Anthropic header or top-level field) and answers `400` naming the offending field otherwise. Scenario selection rides the model id (`mock-text` with reasoning deltas first, `mock-artifact` and `mock-question` issuing scripted tool calls whose arguments the shell must execute and answer), so the app needs no control channel: pick a model in the picker, get that script. The harness inspects the recorded request log (`/__requests`, authorization always redacted) to assert the translator's output end to end; `pnpm mock` starts it for a manual run, and `/__shutdown` exits the process so teardown never leaves a listener behind.

**D121 — The drawer's producer listens where the shell already listens: turn events say "compiling", turn-done says "live", and the row is the record.**

Decided 2026-10-09 (Phase 1–5 completion plan, slice 3a; the second half of D113 — "no production
producer until a host drives turns" — that host exists now: the translator turns (D119) and the e2e
mock drives them (D120)). Two signals and one read. (1) `block_start` on the `artifact` tool flips
the drawer to compiling **with no id**: the model asked, the id does not exist until the loop
generates it, and the drawer must never sit silent through that window — so `setCompiling` widens to
`string | null` for exactly this frame. (2) turn-done reads `artifact_latest`, a new command
returning the thread's newest row (`latest_artifact`: newest `created_at` wins, tie by version,
never crosses threads) with its source resolved from the session root, and lands it: content into
the shell's store, then `setLive(id, version)`. **No row clears the spinner** instead of letting it
spin forever — a call that never committed must not leave a permanent "Compiling…" — and a failed
read is a typed reason through the view's notice, never swallowed and never fatal (the `ChatView`
transcript precedent). (3) The drawer prepares when the artifact is *known*, not when the state
says compiling: the input is what changes the output, so the compiling→live flip of an unchanged
artifact re-runs nothing while a refresh re-prepares exactly once. The producer runs inside
`ChatView` — the conversation-scoped view that already owns this thread's listeners — which is the
caller §7a demands; `phase3.e2e.test.tsx` keeps its test-local driver as the composition proof
under test, now beside the production one rather than standing in for it.

**D122 — The handshake's first contact is the frame's, and the host listens on its own window:
cross-origin access is what the sandbox refuses, so the host never reaches in.**

Decided 2026-10-09 (Phase 3 gate: the webview proofs). `hostSide` and the frame's boot responder
existed as two halves that never met in the product: the host waited for a window-level
`artifact.hello` **on the frame's window** — an opaque, cross-origin window, exactly what `D2`
exists to refuse reaching into — and the frame waited for an `artifact.boot` that nothing sent.
Both were unit-tested against each other by hand; neither was reachable by the app, so a webview
proof of "a refused handshake leaves the frame inert" would have been unobservable theatre. The
loop closes in the direction the sandbox permits: the frame posts its hello to `window.parent`
(`"*"` — an opaque origin cannot name anyone, the same reason `bootChannel` uses it), and the
host's listener rides the **shell's own window**, where `event.origin === "null"` and
`event.source === frameWindow` are both observable without crossing the boundary.
`ArtifactDrawer` attaches the host half when a live frame is on screen, re-attaching per document
(the transferred port dies with the old one), exposes readiness as `data-artifact-channel`, and
routes error-level reports into the drawer's existing failed presentation — a silent runtime
error is the blank-frame bug again, which is the one thing that component exists to prevent. The
proofs then observe the real chain end to end: hello → validated → boot + port → claimed → `ready`.

**D123 — `srcdoc` can never run an artifact script, so the document is served from the app origin with a header policy.**

Decided 2026-10-10 (Phase 3 gate: the webview proofs, slice 3c). A `srcdoc` document
inherits the shell's *response-header* CSP through the policy container, and the shell's
`script-src 'self'` never allows an inline script — so no artifact script could ever execute
under `srcdoc`, whatever nonce the frame's own meta policy carried. Empirical, from the proof
harness against the real build: frame meta nonce == script-tag nonce (`b536875…`, 9403 chars)
yet the script never booted, and a clone probe drew three `script-src-elem` violations from the
inherited policy. The transport is therefore a document served from the app origin: the shell
preempts the `tauri` scheme's handler (`register_uri_scheme_protocol`, which Tauri's built-in
only registers when the scheme is not already taken) and answers `/__clauro/doc/<nonce>` with
`artifact_csp(nonce)` as a **header** — the one policy Rust assembles (D3), delivered before any
content parses, with the nonce doubling as the path token so header and tags can never disagree.
`sandbox="allow-scripts"` stays the sole boundary; `event.origin` stays `"null"`. This
supersedes D2's transport clause (supersede, never renumber): `srcdoc` was the wrong vehicle,
`sandbox` was always the boundary. Rejected: a `data:`-URL transport (same inheritance class
of problem, worse debuggability) and dev/prod parity theatrics — dev mode was already blank
under the shipping CSP, and that pre-existing gap stays honestly deferred, not papered over.

**D124 — The artifact document lives on a remote-by-construction host, because the frame owns a `__TAURI_INTERNALS__` object on Windows and absence is unachievable.**

Decided 2026-10-10 (Phase 3 gate: the webview proofs, slice 3c; found by the proofs, fixed in
the same commit). Tauri marks every init script `for_main_frame_only: true`
(tauri-2.12.1 `manager/webview.rs:161`), but wry 0.57.0's WebView2 backend ignores the flag
(`webview2/mod.rs:507` adds every script via `AddScriptToExecuteOnNewDocumentAsync`, and its
own docs admit scripts reach subframes regardless) — so the artifact frame owns a
`__TAURI_INTERNALS__` object with a working-shaped `invoke`, exactly the D6 nightmare. Observed,
not theorised: the proof surface-dump reads `{type: "object", keys: ["plugins"], invoke:
"function", ipc: "object"}` (`invoke`/`ipc` are non-enumerable `defineProperty` installs, hence
absent from `keys`). Deleting it from the frame is impossible — the installs are
non-configurable — and page CSP cannot block host-injected scripts, so the literal "absent"
property of Tasks/013 criterion 1 is unachievable on this floor. What closes the hole is the
host half, in two layers that are each pinned by test: (1) the document is served from a
dedicated `artifact` scheme (`http://artifact.localhost/…` on Windows,
`artifact://localhost` elsewhere) registered at the wry level, never through Tauri's protocol
map — so the URL matches none of `is_local_url`'s three branches (tauri-2.12.1
`webview/mod.rs:1961`: not the `tauri` protocol URL, not the app URL, scheme unknown to the
map) and every invoke from the frame arrives as `Origin::Remote`; (2) no capability grants a
remote context (`src-tauri/capabilities/default.json` carries no `remote` key, pinned by
`no_capability_grants_a_remote_context`) — so `on_message`'s ACL check (`webview/mod.rs:2080`,
"remote content can never reach custom commands unless an explicit `remote` capability has
been configured") rejects before any handler runs. The fetch path never leaves the frame at
all (`connect-src 'none'`). Proven end to end: a frame-side `invoke('webview_status')` never
resolves while the shell's identical invoke resolves — `scripts/webview-proofs.mjs` claim 1,
8/8 green. What this does **not** prove is stated with it: frame-side a host rejection and a
lost response both read as a hang, so the proof shows no *response* ever reaches the frame and
the *dispatch* closure is the cited host code plus the two pinned premises — not an observed
rejection. Any future `remote` capability must revisit this decision first; the test fails
until it does.

## 5. Security posture — stated plainly

Clauro makes these claims and this is what backs them:

| Claim | Backed by |
|---|---|
| No telemetry, ever | D38 |
| API keys in the OS keychain, never in SQLite | `keyring` crate |
| Conversations never leave the machine except to your chosen provider | Direct provider calls, no proxy |
| Artifacts cannot reach the app | D2 — opaque origin · D124 — the document host is remote to Tauri's IPC, so the frame's injected internals stay inert |
| Artifacts cannot make network requests | D3 |
| Artifacts cannot read your files | D124 + D31 — the frame's `invoke` fails closed at the host ACL, `fs` is host-mediated |
| You approve every command before it runs | D66 — per-invocation, nothing persisted, no allowlist · D67 — opt in per project |
| The model cannot ask you to paste a secret | D43 — the `question` card persists into the thread, so secret-shaped prompts are refused at the tool boundary |

Two of these deserve their reasoning, because both are places where a reasonable shortcut would
quietly break a promise rather than merely degrade a feature.

**`bash` approval (D66).** The obvious design is a persisted allowlist — "trust this command
pattern" — and it is the wrong one here. A prompt-injected model that inherits an allowlist can run
unattended inside the session workspace, and nothing in the UI says so. Per-invocation approval
costs an interruption on every command, and **that interruption is the feature**: it is what makes
"the model cannot act without you" a statement about the architecture rather than a statement about
your judgement under time pressure. There is no yolo mode in v1.

**`question` secrecy (D43).** A question card is durable — it lives in the append-only log and
survives compaction and export. That makes the tool a channel through which a model can ask the user
to persist a credential into a file that gets synced, backed up, and shared. The tool therefore
refuses secret-shaped prompts the same way the memory tool refuses to store government ID numbers,
and the refusal is silent to the model — the question simply fails as a typed `tool_result`.

**And the honest caveat:** with `bash` enabled, Clauro executes model-authored commands on your
machine under your account. It is scrubbed of credentials, process-group killed, and confined to a
session workspace — but it is **not** a sandbox. There is no container, no namespace, no seccomp.
Do not enable it on a machine where that matters, and do not describe Clauro as sandboxed when you
have it on.

## 6. Platform reality — two webviews, not one

Linux and Windows only. Both run a system webview, so the artifact sandbox (D2) depends on an engine
we do not ship and do not control.

| | **Windows** | **Linux** |
|---|---|---|
| Engine | WebView2 (Edge/Chromium) | WebKitGTK |
| Install burden | ~0 — preinstalled on Win 10/11 | distro packages; **not** uniform |
| `sandbox` attribute | Chromium semantics, well documented | **incomplete and distro-dependent** |
| Opaque origin on `srcdoc` | expected to hold | **must be proven** |
| Path risks | `MAX_PATH` 260, reserved names `CON`/`PRN`/`NUL`/`COM1`, backslash separators | case-sensitive FS, `chmod`/DACL not applicable, symlink escape |
| File-permission model | **DACL** (D34) | POSIX mode bits, `0o600` temp, `0o700` staging |
| Keyring | Windows Credential Manager | Secret Service (libsecret); **may be unavailable on headless/headless-adjacent setups** |

**The asymmetry that matters:** Windows is the low-risk platform for this product and Linux is the
open one. Do not let that asymmetry quietly reorder the roadmap — ship Linux, but spike its sandbox
first, and if WebKitGTK will not hold an opaque origin, **disable artifacts on Linux rather than
weakening D2**. A feature that works on one platform and is unsafe on the other is a worse product
than a feature that is honestly absent.

## 7. Rejected, with reasons

| Rejected | Why |
|---|---|
| Parsing first-party artifact XML | Removed the entire class of unknown. D1 |
| `allow-same-origin` on the artifact frame | Disables the sandbox. D2 |
| Public CDN allowlist for artifacts | Supply chain per artifact, and a privacy claim we don't need. D3 |
| Background memory extractor | The model writes memory itself; a second writer is a race. D7 |
| Injecting memory into `system` | Duplicates the API's own protocol. D11 |
| Agent-callable `compact` tool | HTTP 400 on newer accounts, untestable under BYOK. D14 |
| Client-side compaction on Anthropic | Same 400, plus the SDK path is deprecated/removed. D15 |
| A modal / composer takeover for the `question` card | Breaks the stream and discards scroll position. D41 — **note: both MIT references ship a composer takeover**, so this is a deliberate divergence, not a port |
| A persisted `bash` allowlist | A prompt-injected model would run unattended and the UI would not say so. D66 |
| Editing or pruning stored history | Invalidates thinking. Append-only. D19 |
| A summariser system prompt | Invalidates the cached prefix. D13 |
| Bundling a model catalogue | 5.3 MB > budget. D23 |
| An official Rust SDK | 0.0.8, 2024. D24 |
| Filtering denied tools from results | Model can still call them. D26 |
| Truncating tool output at write time | Loses data. D27 |
| Host-path `fs` reach | Blast radius unbounded. D31 |
| Title-as-path | Unstable and unsafe. D32 |
| A separate Gems feature | Duplicates Projects. D35 |
| Agent half of a coding harness | Enormous surface, wrong product. |
| Hosted-service traits — accounts, share links, channels, server automations, cross-user analytics | Not a hosted service. MISSION §"what it is not"; D103, D104 |
| Voice, connectors/MCP, Chrome, Word add-in, Cowork | Server-side or a different product. |

## 8. Later, and why

Revised 2026-10-03 after the LibreChat and LobeHub research. Two things moved *into* v1: client-side
compaction for non-Anthropic providers (D58), and the boundary/generation proof (D63).

### v1 — ships now

Shell · eight tools · Projects · artifact drawer · incognito · thinking effort · themes · export ·
client-side compaction for non-Anthropic providers with the two DeepSeek triggers (D58).

### v2 — capability

| Item | Why v2 |
|---|---|
| General tool loop — parallel calls, retries, budget caps | The one thing v1 deliberately omits. Everything in v1 is single-shot. |
| **Research with named stages**, not a spinner | 5+ tool calls over 1–3 minutes. Needs the loop to be right first. Gemini's Plan → Search → Reason → Report is the shape. |
| **Structured semantic index (D62)** | Only LibreChat does this, with no second implementation to validate the schema against. v1 keeps prose; prose's real loss is *what the agent was trying to do and what came back*. |
| `attach` — copy a directory in, sync back on demand (D44) | Designed, deliberately unbuilt. First thing added if `fs` proves too confined. |
| Artifact versions, Preview/Code tabs, download | Only worth building once the core renders reliably. |

### v3 — scale

| Item | Why v3 |
|---|---|
| Chat search | Needs embeddings — a model dependency, a storage cost, and a privacy decision. Decided: **remote API, opt-in at the feature level**, because a local model would triple the binary for a feature two releases out. |
| RAG for projects | **Rides along on the same index.** Once chat search exists this is close to free. |

Two ideas worth stealing when we get there: **report → artifact** (a Deep Research report becomes a
canvas you can turn into a page, so research output lands in the drawer instead of a dead-end
document), and **guided learning** (the model quizzes you on what it just taught you).

## 9. Open — these gate the plan

1. **The artifact sandbox must be verified on *both* engines, and WebKitGTK is the risk.**
   D2 is correct on paper and only running it proves it. Windows WebView2 is the low-risk case —
   Chromium, and Chromium's `sandbox` attribute behaviour is well documented. **WebKitGTK is the
   open one:** the `sandbox` attribute has historically had incomplete or distro-dependent
   enforcement there, and some distributions ship builds that weaken it. If an artifact frame on
   Linux turns out not to be reliably opaque-origin, the Linux build must fall back to
   **artifacts disabled**, not to a weakened sandbox. **Spike this first — it can veto the feature on one platform.**
   *`bash` is **not** part of this spike* — D46 settled that it does not inherit the Linux gate. It is
   a host-side capability, root-confined and opt-in regardless of engine (D66, D67). Conflating the
   two boundaries would disable a useful feature on one platform for a risk that is not shared.
2. **Does on-demand server compaction require paid auth?** Docs mark it beta but never state the plan
   gate. If gated, D15's non-Anthropic path becomes the only path.
3. ~~Consumed-vs-reserved context~~ → **resolved.** Clauro fires when **either** bound is crossed:
   `trigger = min(0.8 × contextWindow, (contextWindow − max(maxOutputTokens, buffer)) − headroomTokens)`,
   per **D64**. Two bounds, not one: a large-output model on a modest window overflows before a bare
   ratio fires, and an over-eager bound compacts constantly. Corrected 2026-10-03 after audit 3 —
   this entry previously restated the trigger *without* the `min()` or the headroom, contradicting
   D64 itself.
4. **Embeddings for v3: local model or remote API?** A remote index breaks the local-first promise; a
   local model costs MB and needs a Linux build and a Windows build. Decided: **remote API**, and
   v3 chat search is opt-in with a clear consent gate, because shipping a 200 MB embedding model
   would triple the binary for a feature two releases out.
5. **Windows `MAX_PATH` budget for the workspace tree.** Two slug levels plus filenames. Cap and test.
6. ~~Attachments dedupe scope~~ → **resolved.** **Per project** (D52). Global content-addressing would
   make one project observable referencing a file another supplied.
7. ~~`bash` opt-in granularity~~ → **resolved.** Per project to enable (D67, and enabling also opens a
   fresh thread), per-invocation to approve, nothing persisted (D66). No yolo in v1.
8. ~~Linux distribution floor~~ → **resolved.** The oldest LTS tier with WebKitGTK 2.40+ (D50), because
   D45 depends on sandbox enforcement being consistent across the supported range. Cargo ships
   WebKit2GTK sys crates but a distro-native build differs again, so **the CI matrix is the contract**.
9. ~~Windows WebView2 runtime strategy~~ → **resolved.** Evergreen bootstrapper, ~1.5 MB (D49). Needs
   network on first run, which is the failure mode on locked-down machines — accepted, with D53's
   pre-paint detection so the failure is explained rather than a blank window.
10. **LibreChat's compaction trigger was never located** despite nine targeted searches across two
    audit passes. Recorded `UNVERIFIED` rather than guessed. **Finding this is my job, not a plan
    risk** — it does not block v1, because our trigger is settled by D12/D64/D81 and does not depend
    on LibreChat.
11. ~~**On-demand server compaction may be plan-gated.**~~ → **RESOLVED by D75.** The Models API
    exposes `capabilities.compaction`, so availability is checked at runtime per model. No live key
    required to decide. D81 additionally makes threshold compaction the preferred path, which needs
    neither the capability check nor a separate request builder.

**After both audits, no open question requires a live API key.**

## 10. Provenance

| Source | Licence | Used for |
|---|---|---|
| OpenCode (`anomalyco/opencode`, `dev`) | MIT | Compaction math, tool registry architecture, tool-output bounding, permission evaluation |
| DeepSeek Harness (`deepseek-ai/deepseek-harness`, `master`) | MIT | Compaction trigger ratios, overflow recovery, prefix-cache reuse, command-runner seam, Windows DACL semantics |
| Anthropic API docs | proprietary | Memory tool, context editing, compaction, preserved thinking, tool reference |
| Gemini app | proprietary | Gems, Canvas, staged research progress |
| LibreChat (`LibreChat-AI/LibreChat@main`, MIT) | MIT | Summary accounting channel + pre-invoke marker (D57), boundary-marked checkpoints, incremental fold summariser, model-tokenomics resolution chain |
| LobeHub (`lobehub/lobehub@canary`) | **LobeHub Community License — NOT open source (D59)** | Observation only: structural boundary detection as an idea (D61). No code reused. |
| Open WebUI (`open-webui/open-webui`) | **Custom licence with branding clause — inspiration only (D103)** | Observed behaviour, mirrored in our own words and implementation. No code reused. |

Full research with per-claim confidence ratings: `.agents/research/`. Read `DECISIONS.md` there for
the 22 STEAL / 20 SKIP / 20 ADAPT derivation behind these decisions.