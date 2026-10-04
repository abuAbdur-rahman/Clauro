# Clauro — ARCHITECTURE.md

**How the pieces relate.** Sits after `CONTRACTS.md` (the shapes tests assert against) and before
`DESIGN.md` (how it feels). It is the **realisation** of the contracts, not a second source of
them — anything here that looks like a new decision is a mistake; it belongs in `DECISIONS.md` with
a D-number, cited from here. **D87.**

**This file mints no decisions.** Every claim cites a D-number, a contract section, or a task.

---

## 1. The shape

```
┌─────────────────────────────────────────────────────────────────────────┐
│  React 19 · TypeScript strict · Tailwind · Zustand                       │
│                                                                          │
│  projects rail │ transcript │ artifact drawer │ palette │ settings        │
└───────┬──────────────────────────────────────────────┬─────────────────┘
        │ Tauri IPC (capability-scoped)                │ MessageChannel
┌───────▼───────────────────────────────┐  ┌───────────▼──────────────────┐
│  Rust workspace                        │  │  Artifact frame               │
│                                        │  │  srcdoc                       │
│  clauro-app      ← Tauri shell, thin   │  │  sandbox="allow-scripts"     │
│  src-tauri       ← window, menus, tray  │  │  NO allow-same-origin        │
│  (artifact pane) ← compile, CSP, ch. │  │  CSP built in Rust (D83)     │
└───────┬────────────────────────────────┘  └──────────────────────────────┘
        │
┌───────▼────────────────────────────────────────────────────────────┐
│  clauro-core       ← no tauri. models, blocks, rules                 │
│  clauro-loop        ← serial turn loop, prompt, queue               │
│  clauro-transport  ← SSE + the two provider adapters              │
│  clauro-tools      ← the eight handlers, registry, permissions    │
│  clauro-fs         ← path safety, workspace layout, process run.  │
│  clauro-store      ← SQLite, the compaction ledger                │
│  clauro-tokens     ← TokenMeter + CompactionPolicy                  │
└───────┬────────────────────────────────────────────────────────────┘
        │
┌───────▼──────────┐        ┌──────────────────┐
│        (remote) │───────▶│ provider API     │
│  Anthropic + one │        │ + models.dev     │
│  OpenAI-compat   │        └──────────────────┘
└──────────────────┘
```

**Dependencies point inward. `clauro-core` depends on nothing but `serde`.** A handler in
`clauro-tools` may not import `tauri`. Both are asserted by failing tests in `Tasks/002`, not by
convention — the test is what makes the rule survive a well-meaning refactor.

**Why the split exists:** `CONTRACTS.md` §7 promises every test hangs off a contract with no
provider, no network and no webview. That is only true if the pieces that hold those contracts do
not depend on the pieces that need a GPU, a window, or an API key. The workspace layout is not a
preference; it is what makes the test suite possible.

## 2. The turn loop — the spine

`D85`, owned by `Tasks/023`. Everything else hangs off this.

```
user message
      │
      ▼
┌─────────────────────────── one request ───────────────────────────┐
│ system (frozen, hashed)  +  tools (frozen)  +  messages          │
│ thinking.effort ──────────── request parameters, NOT prompt (D76)│
└──────────────────────────────────┬───────────────────────────────┘
                                   ▼
                          stream begins
                                   │
        ┌──────────────────────────┴──────────┐
        │ text / thinking deltas              │ tool_use block
        ▼                                     ▼
   append blocks            ┌──────────────────────────────────┐
   (signature captured)     │ dispatch THROUGH THE REGISTRY      │
                            │ → permission resolve (fail-closed) │
                            │ → consent, if the tool needs it   │
                            │ → handler returns ToolOutcome     │
                            │ → bound on the way OUT (D27)      │
                            │ → nothing throws across (D55)     │
                            └──────────────┬───────────────────┘
                                           │
                     append tool_result ────┤  (D65 — always, even cancelled)
                                           ▼
                              ┌────────────────────────┐
                              │  more tool_use in this  │──yes──┐
                              │  message?              │        │
                              └─────────┬──────────────┘        │
                                   no   │                       │
                                        ▼                       │
                                    end_turn ────────────────────┘
```

**Three properties the loop guarantees, each independently tested:**

1. **Serial dispatch in v1.** One `tool_use` at a time, in order. Parallel calls, tool-level
   retries and budget caps are v2 — the loop has no concept of them, so there is nothing to
   misconfigure.
2. **Nothing throws across the boundary.** A handler that throws becomes a typed `error`
   `tool_result` and the loop continues. The model decides what happens next (**D55**).
3. **A cancelled turn is not a lost turn.** Every dispatched call is closed with an `aborted`
   result and completed work stays in the log (**D65**, **D68**).

**The system prompt is built once.** Assembled at first turn, hashed into `thread.system_frozen`,
never rebuilt. It carries the tool inventory, the `fs` preconditions, the output-bounding behaviour,
and **our own** memory protocol — never first-party wording (**D7**, **D11**, **D39**). Enabling
`bash` on a project changes the tool list, which changes the hash, which is why the opt-in opens a
fresh thread (**D67**).

## 3. Two security boundaries

The product makes four claims to the user. Exactly two mechanisms carry them.

### 3.1 The artifact frame — an opaque origin

```
parent (React)                    frame (srcdoc)
─────────────────────             ─────────────────────────────
MessageChannel                    window.__TAURI_INTERNALS__
  port1 ─────────────────────────▶  ✗ unreachable — opaque origin
  port2 ◀─────────────────────────  (about:srcdoc INHERITS the
                                     parent origin; the `sandbox`
validate event.origin              attribute is what forces opaque)
AND event.source ── every msg
  both directions (D6)
```

**The single most important line in this document:** Tauri v2 gates commands by **capability and
scope, not by caller origin**. Any path from the frame to `window.__TAURI_INTERNALS__` means a
generated artifact can run every command the app can. Omitting `allow-same-origin` is the only
thing standing between them — adding it back silently breaks this **and** breaks the `event.origin`
validation the same design depends on.

The CSP is assembled in Rust, not written in the document, because it must agree with what the
compiler emits. `default-src 'none'` is the load-bearing line (**D83**): without it,
`connect-src 'none'` blocks `fetch` and nothing else, and an artifact can still load a remote
`<script src>` or embed a remote `<iframe>` — and `sandbox` does **not** inherit into nested
browsing contexts, so CSP is the only remaining control on that path.

`script-src` carries `'unsafe-inline' 'unsafe-eval'` because Sucrase output is inlined and
`eval`'d. That is safe **only because the origin is opaque**, which is why the two mechanisms are
one decision, not two.

### 3.2 The tool host — side effects are host-owned

```
model proposes ──▶ registry ──▶ permission ──▶ consent ──▶ handler
                    (D26)         (fail-closed)  (D66)        (D29/D33)
                                                                │
                    filesystem ◀────────────────────────────────┘
                    process     ◀────────────────────────────────┘
```

Every side effect happens in Rust. The model never touches a path, a process, or a network
directly. Three consequences worth stating plainly:

- **`fs.edit` requires a prior `read` this session** — host state, not a sentence in a prompt. A
  prompt is advisory (**D33**).
- **`bash` executes model-authored commands on your machine.** Off by default, per-project,
  every invocation approved, nothing persisted. It is credential-scrubbed and process-group killed,
  and it is **not a sandbox** — no container, no namespace, no seccomp. We do not describe Clauro as
  sandboxed while it is enabled (**D28**, **D29**, **D66**).
- **The workspace is a tree Clauro owns** (`D31`). Attachments are copied in; no arbitrary host
  path ever enters the picture, so a compromised session's blast radius is one directory (**D44**).
  Opaque IDs are authoritative — a title is not a safe path component (**D32**).

## 4. Storage and the surface

Eleven tables. The rule that matters: **history is append-only, and a compaction is a ledger entry,
not a deletion** (**D84**).

```
message(seq) ──┬─ covered by compaction_event.generation = N  → superseded
               └─ seq > covers_to                             → on the surface

surface = latest compaction_event + its summary_block + everything after covers_to
```

The rows underneath stay on disk. That is not an oversight — it is what makes the append-only
guarantee **auditable**: the row is still there to check the derivation against. A design that
physically removed them would make the correctness argument unfalsifiable.

This also settles where a real `DELETE` lives. Exactly one place: `Tasks/019`'s *delete every byte*,
which is why that task asserts against the real filesystem and recursively walks the tree. A mocked
delete would pass while the files stayed.

## 5. The provider seam

Two adapters (**D48**): Anthropic, and one OpenAI-compatible adapter for everything else. The
transcript never branches on provider — that is what makes the second one cheap.

```
raw SSE ──▶ parse ──▶ NormalisedEvent ──▶ ContentBlock ──▶ UI
                │            │
                │            └─ usage: iterations, never top-level after compaction (D70)
                └─ unknown events are `ignored`, never fatal (D80)
```

`capabilities.compaction` picks the compaction path **at runtime, with no live API key** (**D75**).
The two adapters differ in ways that matter and are named so they stay visible: streaming deltas,
tool-call framing, and reasoning-token fields all vary between implementations. When the adapter is
unsure it **degrades visibly** — it says so in the transcript rather than rendering a
plausible-looking wrong one.

The compaction trigger is computed in exactly one place, with **proportional caps and a floor** so
no window can produce a non-positive trigger (**D82**). That single function is the reason a 8,192-
token local model works at all; the naive form went negative on every model below an 85,536-token
window.

## 6. Platform reality

| | Windows | Linux |
|---|---|---|
| Engine | WebView2 (Chromium) | WebKitGTK |
| Risk | **Low** — `sandbox` is well documented | **Open** — enforcement is incomplete and distro-dependent |
| Packaging | Evergreen bootstrapper (~1.5 MB), first run needs network (**D49**) | Distro-native, WebKitGTK 2.40+ floor (**D50**) |
| Path model | **DACL, not mode bits** (**D34**) — `chmod` only drives read-only | POSIX modes |

**Windows is the low-risk platform and Linux is the open one.** Ship both, spike Linux first
(`Tasks/001`), and if WebKitGTK will not hold an opaque origin, disable artifacts there rather than
weakening the rule. A feature that works on one platform and is unsafe on the other is worse than a
feature that is honestly absent — and the absence is announced **in the product**, not a changelog
(**D45**).

`bash` does **not** inherit this gate (**D46**). The frame's safety depends on the webview engine;
`bash` is a host-side capability that is root-confined and opt-in regardless.

**The CI matrix is the contract** (**D50**). Cargo ships WebKit2GTK sys crates, but distro-native
builds differ from them, so a green local build says nothing about the supported range.

## 7. What the architecture refuses

Each of these was available and rejected; the reason is recorded in `DECISIONS.md`.

- **A host-process agent loop.** No subagents, no worktrees, no hooks. The product is a chat client
  with a drawer.
- **A physical delete for compaction.** See §4 — the ledger is the point.
- **A summariser system prompt.** It would invalidate the cached prefix we just warmed (**D13**).
- **A chosen-directory `fs` root.** An escape hatch is cheap to add later and expensive to retract
  (**D44**).
- **A persisted `bash` allowlist.** A prompt-injected model inheriting one would run unattended with
  nothing in the UI saying so (**D66**).
- **Public CDN hosts for artifacts.** They would put third-party supply chain inside every generated
  page (**D3**, **D83**).
- **A bundled model catalogue.** 5.3 MB exceeds the entire binary budget (**D23**).