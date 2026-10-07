# Clauro — SPEC.md

**The normative statement of what v1 is.** Where this disagrees with `DECISIONS.md` §3,
`ROADMAP.md`, `CONTRACTS.md` §6 or `PHASES.md`, **this file wins** and the other is a bug to fix.
That is the whole reason it exists: *what is in v1* was previously stated in four places
independently, and two audits found them disagreeing — a feature declared in one and owned by no
task in another. **D87.**

**This file mints no decisions.** Every claim cites a `D` number, a `CONTRACTS.md` §, or a `Tasks/NNN`.
A citation that does not resolve is a defect in this file. Anything genuinely new is a D-number in
`DECISIONS.md`, cited from here.

**How to read it:** §1 the release boundary · §2 the eight tools · §3 the surfaces · §4 the
requirements, each with the test that proves it · §5 what is deliberately not in v1 · §6 the
definition of done.

---

## 1. The release boundary

| | |
|---|---|
| **Platforms** | **Windows is primary and is where development happens.** Linux is secondary; macOS is deliberately out (**D49**, **D50**, **D88**, **D89**). No cross-compilation: one platform, one toolchain. |
| **Budget** | ~25 MB. Raised from <15 MB, which was never measured. |
| **Accounts** | None. **No telemetry, ever** (**D38**). |
| **Licence** | MIT, public repo — which is *why* LobeHub is observation-only (**D59**, **D60**). Open WebUI is inspiration-only (**D103**). |
| **Method** | TDD + SDD. No code without a task; no code without a failing test first (`AGENTS.md` §6). |

**One gate can change the shape of the release:** `Tasks/001` decides whether WebKitGTK holds an
opaque origin. If it does not, **artifacts are disabled at runtime on Linux with an in-app notice
naming the reason** (**D45**) — never weakened (**D2**). `bash` does **not** inherit that gate
(**D46**).

## 2. The eight tools

`compact` is the only one the model cannot call.

| Tool | Model-callable | Owning task | Authorising decisions |
|---|---|---|---|
| `memory` | ✅ | `008` | **D7**, **D11**, **D43** |
| `artifact` | ✅ | `013`, `014` | **D1**, **D2**, **D3**, **D83** |
| `web-search` | ✅ | `011` | **D39** (wording) |
| `web-fetch` | ✅ | `011` | **D39** (wording) |
| `fs` | ✅ | `010` | **D31**, **D32**, **D33**, **D34**, **D44**, **D52**, **D79** |
| `question` | ✅ | `009` | **D40** ported; **D41**, **D42**, **D43** original |
| `bash` | ✅ **off by default** | `012` | **D28**, **D29**, **D30**, **D66**, **D67** |
| `compact` | ❌ **host-driven** | `016`, `017` | **D12**, **D13**, **D14**, **D58**, **D82** |

The loop that drives all eight is `Tasks/023` (**D85**). Read order is `007` → `023` → the handlers.

## 3. The surfaces

| Surface | Owning task | Authorising decisions |
|---|---|---|
| Projects rail (instructions folded in) | `018` | **D35**, **D36** |
| Transcript | `006` | **D54**, **D61**, **D65**, **D68**, **D84** |
| Memory Topics UI — pause / reset / per-chat | `008`, `018` | **D8**, **D9** |
| Attachments | `010`, `018` | **D36**, **D47**, **D52** |
| Artifact drawer | `013`, `014` | **D1**, **D2**, **D3**, **D45**, **D83** |
| Composer — thinking effort, per-thread model | `003` | **D19**, **D54**, **D76** |
| Composer — attach, `memory` toggle, `bash` | `010`, `012`, `020` | **D8**, **D28**, **D66** |
| Incognito | `019` | **D37** |
| Export / import | `019` | **D19**, **D38** |
| Themes, hotkey, command palette | `020` | — |
| Deleting every byte | `019` | **D10** |

## 4. Requirements

Each row is a claim plus the test that proves it. The test column is a pointer into `Tasks/NNN`,
not a restatement — the task file owns it.

### 4.1 Shell

| # | Requirement | Proven by |
|---|---|---|
| S1 | API keys live in the OS keychain, never in SQLite, never in a log. `grep -ri 'api[_-]?key\s*='` finds nothing. | `003` |
| S2 | The model catalogue is fetched and cached, **never bundled** (~5.3 MB exceeds the whole budget). An unknown model degrades to a typed notice. | `003` (**D23**) |
| S3 | From process start to first send, **no request leaves to any host other than the one already configured** — with one exception: the Windows WebView2 runtime check, OS-vendor infrastructure, first run only (**D49**). | `002`, `003` |
| S4 | A missing WebView2 runtime is detected and explained **before first paint**. Never a blank window, never a bare crash (**D53**). | `003` |
| S5 | The core crate runs with no display, and `clauro-tools` does not depend on `tauri` — both asserted, not assumed. | `002` |

### 4.2 Transcript and history

| # | Requirement | Proven by |
|---|---|---|
| T1 | History is **append-only**. `message` and `block` are never updated or deleted; a correction is a new row at a higher `seq`. Exactly four tables are mutable. Forking copies a thread's prefix rows into a new thread; the source is untouched (**D99**). | `004`, `019` (**D19**) |
| T2 | **Compaction never deletes.** It writes a `compaction_event`; the surface is a query over the ledger (**D84**). | `004`, `016`, `017` |
| T3 | Every dispatched tool call gets a result, including cancelled ones (**D65**). A turn stopped mid-call **keeps completed work** (**D68**). Follow-ups sent mid-stream queue visibly; stop offers drain-or-discard (**D98**). The queue drains as in-order turns, never merged (**D105**). | `006`, `023` |
| T4 | Reasoning renders as **one collapsible inline region, one shape**, both providers (**D54**). | `006` |
| T5 | Every assistant `tool_use` keeps its result across a compaction boundary (**D61**, **D18**). | `015`, `016` |
| T6 | Thinking is re-sent only as an **unbroken run**, with `signature` captured (**D72**). | `005`, `006` |
| T7 | Regenerate-last and edit-resend append new rows at a higher `seq`; nothing is rewritten in place (**D99**). A truncated turn resumes via continue-append to the same turn (**D106**). | `006` |
| T8 | Transcript HTML is purified before render; streaming markdown reparses at most once per frame (**D100**). | `006` |

### 4.3 Tools

| # | Requirement | Proven by |
|---|---|---|
| C1 | All eight registered. `compact` is **absent from the request schema** and reachable only as `/compact` (**D14**). No runtime tool loading or dependency install — the set is fixed at eight (**D108**). |
| C1a | **Every tool is declared on the first request**; the effective per-thread set changes via `tool_addition`/`tool_removal` with `defer_loading: true` on the Claude API (**D94**), and via a frozen array on the OpenAI-compatible adapter (**D19**). Both paths are tested — they differ on purpose. | `007`, `012` |
| C2 | A denied tool is **removed from the request**, not filtered from results (**D26**). | `007` |
| C3 | Permission resolution is two pure, total stages: fold per effect, then fail-closed precedence. **Both** asserted, because the spec previously stated two mutually exclusive rules. | `007` (`CONTRACTS.md` §3) |
| C4 | Output is bounded **on the way out**. Full text stays addressable and re-readable; nothing is truncated at write time (**D27**). | `007`, `008` |
| C5 | **Nothing throws across the tool boundary.** A non-zero exit is `ok` with output attached (**D55**). | `023` |
| C6 | The prompt is advisory; the host is authoritative. `fs.edit` errors without a prior `read` this session, enforced in Rust (**D33**). | `010` |
| C7 | `fs` refuses any path outside the Clauro-owned workspace (**D31**, **D44**). Path safety order is: canonicalise → resolve symlinks → **then** traversal check (**D34**). | `010` |
| C8 | `question` is capped at one per assistant turn, always offers skip, renders **inline** (**D41**), and refuses secret-shaped prompts (**D43**). A second `question` call in the same turn — alone or beside another tool — is refused as a typed `tool_result` (**D101**). | `009` |
| C9 | Neither `question` nor `memory` stores a secret. Both refuse the same `looksSecret` predicate, **silently**. A 32-char git SHA must pass — a guard that refuses commit hashes gets turned off. | `008`, `009` |
| C10 | `bash` is off by default, per-project, **every invocation approved, nothing persisted** (**D28**, **D66**). Enabling opens a fresh thread (**D67**). Approval is **not** a palette action. | `012`, `020` |
| C11 | Attachments are copied into the workspace, deduped **per project** (**D52**), and the model receives path + size + media type — never inline bytes (**D47**). A Windows reserved-name upload is renamed, not rejected. Served tool-output files use attachment disposition with nosniff for non-media types (**D109**). | `010`, `018` |

### 4.4 Artifacts — the security boundary

| # | Requirement | Proven by |
|---|---|---|
| A1 | The frame is `srcdoc` + `sandbox="allow-scripts"`, **never `allow-same-origin`**. The opaque origin comes from **`sandbox`**; `about:srcdoc` inherits the parent origin on its own (**D2**). Sandbox tokens and CSP are host-fixed; no user-facing control may weaken them (**D108**). | `001`, `014` |
| A2 | The iframe's `contentWindow` has **no reachable path** to Tauri internals — Tauri gates by capability and scope, **not by caller origin**. | `014` |
| A3 | `default-src 'none'` is present, closing `script-src`, `frame-src` and `child-src` — `sandbox` does **not** inherit into nested browsing contexts, so CSP is the only control there (**D83**). | `014` |
| A4 | An artifact cannot fetch, load a remote script/image/font/frame, post a form, or open a window (`D3`, `D83`, `D90`). In-frame navigation is contained: same-origin clicks stay in the frame, external targets are blocked and logged (**D102**). Vendor what artifacts need; no CDN allowlist. **We do not claim "no network egress"** — WebRTC, `dns-prefetch` and self-navigation are probed, not closed. | `001`, `014` |
| A5 | Host↔artifact messaging is a `MessageChannel` handshake. The **handshake** validates `event.source === iframe.contentWindow` and origin `"null"`; after that the **port is the capability** and every message is allowlisted (**D6**, `D91`). Port messages carry an empty origin and null source per the HTML spec, so per-message origin validation is not implementable. | `014` |
| A6 | An artifact that throws does not take down the host UI. Sucrase runs in a Worker with a timeout and a size cap (**D4**). SVG through DOMPurify, in the artifact frame only. | `014` |
| A7 | Only predefined Tailwind utility classes (**D5**), and the system prompt tells the model that `localStorage`/`sessionStorage`/`indexedDB` are unavailable — the most common cause of a blank artifact. | `014` |
| A8 | **WebView2 must hold an opaque origin — that gates a Windows release. WebKitGTK is best-effort: if it cannot, artifacts are disabled at runtime on Linux with a notice** (**D45**, **D89**). One package, truth told in the product, and a Linux limitation no longer blocks a Windows release. | `001`, `021` |

### 4.5 Compaction

| # | Requirement | Proven by |
|---|---|---|
| M1 | Fires at `max(2_048, min(0.8 × window, usable))` with **proportionally capped** reserves and a floor — `buffer` has a value and **no window can produce a non-positive trigger** (**D82**). | `015` |
| M2 | The summary call is a genuine **prefix extension**: identical leading tokens, one trailing instruction, `tools` carried through even though the summariser never calls one (**D13**). | `016` |
| M3 | A summariser that changes nothing yields `no-progress` and **cannot authorise a retry** (**D63**). This is what makes the anti-thrash breaker enforceable rather than heuristic. | `016`, `017` |
| M4 | Usage after compaction is read from `usage.iterations`; the top-level fields are **zero** (**D70**). Summary tokens are a **separate channel** with a pre-invoke marker (**D57**). | `016`, `017` |
| M5 | Three paths, chosen at runtime via `capabilities.compaction` — **threshold preferred** (**D81**), on-demand for `/compact` and our own instructions (**D75**), client-side for non-Anthropic (**D58**). | `016`, `017` |
| M6 | **No client-side compaction on Anthropic models.** The prefix check returns 400 for accounts created on/after 2026-08-31, and BYOK means account age varies per user — it cannot be tested away (**D15**, **D20**). | `017` |
| M7 | `compaction` and `context_management` are **mutually exclusive on one request** — combining them is a 400 (**D21**). `clear_at_least` has a real value (**D86**). | `017` |

### 4.6 Deleting every byte

| # | Requirement | Proven by |
|---|---|---|
| X1 | Deleting a thread removes its rows **and its files**. A row deleted with its file left behind is not a delete. | `019` |
| X2 | Deleting a project removes its whole subtree. | `019` |
| X3 | Memory **survives thread deletion by design** (**D10**), so purging it is a separate, separately-confirmed action, and the UI says so plainly. | `019` |
| X4 | A test asserts zero rows **and a recursive walk of the workspace finds nothing** — against the real filesystem, not a mock. | `019` |

## 5. Deliberately not in v1

| Not in v1 | Why | Returns in |
|---|---|---|
| Parallel tool calls, tool retries, budget caps | v1 dispatches serially (**D85**) | v2 |
| Research / deep research | 5+ tool calls over 1–3 min; needs the loop right first | v2 |
| Structured semantic index | Only LibreChat does this; no second implementation validates the schema (**D62**) | v2 |
| Artifact history, pinning, Preview/Code tabs, download | The render must be trustworthy before a user can pin history | v2 |
| `attach` — copy a directory in, sync back | `fs` is confined by design (**D44**); escape hatches are cheap later, retracted promises are not | v2 |
| Chat search, RAG for projects | Embeddings; a local model is ~200 MB and would triple the binary | v3 |
| Hosted-service traits: accounts, RBAC/SSO, share links, channels, server automations, cross-user analytics | Not a hosted service (MISSION; **D104**) | — |
| Parallel multi-model panes, sibling-branch history | Unplanned; each needs its own D-number (**D104**) | — |
| Shared calendar (a pure-local calendar stays unplanned) | Sync and multi-user state (MISSION; **D107**) | — |
| Image-gen-as-tool | v2/v3 media (**D107**) | v2+ |
| Standalone shared notes | Never — Projects plus memory Topics cover the local need; sharing drags sync back in (**D107**) | — |
| Eval-arena and ELO leaderboards | Never — leaderboards need crowds; the local usage footer is the allowed complement (**D107**) | — |
| Voice, video-call, connectors/MCP, Chrome, Word, Cowork | Server-side or a different product (`FEATURES.md` §2.4) | — |

## 6. Definition of done

v1 ships when:

1. Every requirement in §4 has a passing test, and **each of those tests has failed at least once**
   (`AGENTS.md` §6 — *"a test that has never failed proves nothing"*).
2. **No test requires a live API key.** SSE fixtures are synthetic and live in
   `crates/clauro-transport/tests/fixtures/`: omitted thinking, a compaction response, a dropped
   block, an unknown event.
3. Both **platform floors** are green. A failure on a floor invalidates the sandbox guarantee on
   that platform — it is a release blocker, not a warning (**D50**).
   **Deferred 2026-10-06 (D114), owned by Phase 7 (D115):** Linux CI is parked until after full
   development — the Linux jobs are preserved in
   `.github/workflows/linux-matrix.yml.disabled`. Until Phase 7 lands, "both floors" reads as
   the two Windows jobs.
4. Binary ≤ ~25 MB, measured from the empty shell recorded in `Tasks/002`.
5. `Tasks/001` has produced a verdict, and the release matches it.
6. Every ported change carries its attribution, and every prompt in the repo is our own wording
   (**D39**, `AGENTS.md` §4).