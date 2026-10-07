# Clauro — ROADMAP.md

**What ships when.** Scope decisions live in `DECISIONS.md` §8; sequencing lives in `PLAN.md`. This
file is the honest version of "when".

---

## v1 — the local client

**The thesis, made usable.** A user installs Clauro, pastes a key, chats, gets an artifact rendered
live, accumulates memory within a project, runs a command after approving it, and can delete every
byte they ever typed — without the app asking a server for anything.

| | Phase | Tasks |
|---|---|---|
| **0** | Ground truth | `001` sandbox spike · `002` workspace + CI · `003` keyring + model catalogue |
| **1** | Shell | `004` SQLite schema · `005` SSE + Anthropic adapter · `006` transcript + thinking |
| **2** | Tool loop | `007` registry + permissions · `008` memory · `009` question · `010` fs · `011` web tools |
| **3** | Gated features | `012` bash · `013` artifact drawer · `014` compile + CSP + channel |
| **4** | Context | `015` token meter · `016` client-side compaction · `017` Anthropic compaction paths |
| **5** | Product surface | `018` Projects · `019` incognito + export · `020` themes + hotkey + palette |
| **6** | Release | `021` Windows floor CI + gate mechanics · `022` packaging + dependency audit |
| **7** | Linux + floors (post-deployment) | `001` Linux column · Linux jobs + floors · Linux gate proof (all moved, D115) |

**v1 ships:**

- Streaming chat on **two adapters** — Anthropic, plus one OpenAI-compatible adapter for everything
  else. **D48.** The OpenAI-compatible surface is validated against a third-party server, so coverage
  of real providers is an assumption, not a test. **It degrades visibly** — it says so in the
  transcript rather than rendering a plausible-looking wrong one.
- **Eight tools**: `memory` · `artifact` · `web-search` · `web-fetch` · `fs` · `compact` (host-driven,
  never in the request schema) · `bash` (off by default) · `question`.
- **Three compaction paths**, chosen at runtime from `capabilities.compaction` — no live key needed
  to decide. **D75, D81.**
- Projects with per-project memory · incognito · thinking effort · themes · hotkey + command palette ·
  thread export · memory export · **file attachments** (copied into the session workspace, model reads
  via `fs`, dedupe per project — **D47, D52**) · **delete everything** (MISSION's strongest privacy
  claim, discharged in `Tasks/019`).

**Two things moved into v1** during research and would otherwise have been deferred: client-side
compaction for non-Anthropic providers (**D58**), and the boundary-marker + generation-counter proof
(**D63**) that makes the anti-thrash breaker enforceable rather than heuristic.

**Deliberately absent from v1:** parallel tool calls, tool-level retries, budget caps. The serial loop
has to be correct first, and **D56** already covers transport-level retry so v1 is not silently
retry-free.

---

## v2 — capability

The release that makes it an agent-adjacent tool rather than a chat client.

| Feature | Why it waits |
|---|---|
| **General tool loop** — parallel calls, retries, budget caps | Needs the serial loop correct first. This is the real engineering and the part the MIT references got right. |
| **Research, with named stages** | 5+ tool calls over 1–3 minutes. Gemini's shape is Plan → Search → Reason → Report, and the UI should name the stage rather than spin. A spinner for three minutes is a lie about what is happening. |
| **Structured semantic index after compaction** | Only LibreChat preserves revisioned `tool_intent` / `tool_outcome` / `activity_phase` / `reasoning_label` entries rather than prose. No second implementation exists to validate the schema against. **D62.** Prose's real loss is *what the agent was trying to do and what came back*. |
| **`attach`** — copy a directory in, sync back | `fs` may prove too confined without it. Designed, deliberately unbuilt. **D44.** Adding an escape hatch later is cheap; retracting a security promise is not. |
| **Artifact versions, Preview/Code tabs, download** | The render has to be trustworthy before we let a user pin history. |

---

## v3 — scale

| Feature | Why it waits |
|---|---|
| **Chat search** | Embeddings. **Remote API, opt-in at feature level** — a local model is ~200 MB and would triple the binary for a feature two releases out. |
| **RAG for projects** | Rides the same index, so close to free once chat search exists. Auto-activates near the context window, auto-reverts below it, with a visible indicator. |

---

## Considered and declined

Not deferred — declined. `MISSION.md` §"What it is not" is the authority; this is the reasoning.

| | Why not |
|---|---|
| Parallel tool calls in v1 | The loop must be right before it is wide. |
| A reasoning side pane | Competes with the artifact drawer for the same space during exactly the turns where both matter. **D54.** |
| Host-path `fs` | Blast radius unbounded. `fs` roots at a Clauro-owned tree. **D31, D44.** |
| A persisted `bash` allowlist | Lets a prompt-injected model run unattended with nothing in the UI saying so. **D66.** |
| An agent-count feature — subagents, worktrees, MCP, hooks | Enormous surface, wrong product. It is what makes a coding IDE, and we are not one. |
| Voice | A real feature, not ours, and the Web Speech API would make it look like ours. |
| Cloud sync, sharing links, org features | No accounts. That is the product. |
| macOS | Dropped from scope. Windows is the low-risk platform; Linux is the open one. |
| macOS-shaped decisions | — |

---

## The honest timeline

No dates. There is no team, and a date on a pre-prototype document is a fiction someone will later
have to apologise for.

What can be said:

- **`Tasks/001` is two days and it can invalidate a release gate.** Do it first, on purpose, so the
  answer arrives while it is cheap.
- **The first fortnight ends at `Tasks/005`** — a streaming conversation rendering real text from a
  real key, or the earliest point we learn the project is not viable. Both are good outcomes; the
  second is better.
- **The webview floor jobs are where the schedule actually slips.** They are slower, flakier, and
  they are the jobs that can invalidate a guarantee. Budget for them rather than being surprised.

## The one thing that can still change the plan

`Tasks/001`. If WebKitGTK will not hold an opaque origin, artifacts ship Windows-only and Linux gets
an honest notice. **D45** already specifies the path, so no redesign is needed — but it is a real
possibility, not a formality, and it is why the spike precedes everything it could invalidate.