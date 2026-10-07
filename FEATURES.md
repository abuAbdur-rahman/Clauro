# Clauro — FEATURES.md

**What ships in v1, what we borrowed, and what everyone else calls it.**

---

## 1. How to read the provenance tags

Every feature is one of four things. This distinction is the whole point of the project — we are not
re-inventing a wheel, and we are also not copying one.

| Tag | Meaning | Legal position |
|---|---|---|
| **CALLED** | A documented API primitive. The provider does the work; we send the documented parameter and read the documented response. | Nothing copied. This is the sanctioned path. |
| **PORTED** | A design from an MIT-licensed repo. We read the source, took the *idea*, and wrote our own implementation. Attribution recorded. | MIT. |
| **MIRRORED** | Behaviour observed in a shipped product. No code, no wording — we rebuild the *behaviour* because the pattern is proven and we want the same user-visible result. | Clean, as long as no text is reused (D39). |
| **ORIGINAL** | No precedent. We designed it. | Ours. |

**Sources we may port from: OpenCode (MIT), DeepSeek Harness (MIT), LibreChat (MIT).**
**LobeHub is NOT open source** — its licence requires a commercial agreement for any derivative
work. It was read for observation only and nothing was taken from it (D59, D60).
**Anthropic and Google material is proprietary** — behaviour may be mirrored, wording may not.
**Open WebUI is inspiration only** — custom licence with a branding clause, incompatible with our MIT
lineage. Behaviour may be mirrored in our own words and implementation; no code or wording crosses
over (D103).

---

## 2. v1 feature table

### 2.1 The eight tools

| # | Tool | What it does | Tag | What we're specifically mirroring |
|---|---|---|---|---|
| 1 | **`memory`** | The model writes and edits its own persistent notes. Six commands: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. Lives under `/memories/<path>` → SQLite `key`; `category` **is** the topic. | MIRRORED (behaviour) · ORIGINAL (tool) | **Behaviour** from claude.ai Memory: it saves *"a set of individual topics as you chat, rather than summarizing conversations after they end."* That single line is why there is no extractor in Clauro. **Command set** is the documented Anthropic primitive — but D51 means **we define our own tool** so it works on every provider, not just Anthropic's `memory_20250818` server type. |
| 2 | **`artifact`** | The model emits a live page into the right-hand drawer. Input is `{ title, mediaType, source }`. | ORIGINAL | **The concept** — a live page built from full session context — is claude.ai's. **The schema is ours** (D1): we ask via a tool call and never parse an `<antArtifact>` fence. That decision deleted the single largest unknown in the project. Rendering technique (Sucrase in-browser, predefined Tailwind classes only) is PORTED from the React-artifact runner. |
| 3 | **`web-search`** | Query the web, return results. | CALLED | Anthropic's `web_search_*` server tool on Anthropic. Elsewhere, our own adapter calls the provider's search facility or degrades visibly (D48). One prompt line worth more than the rest: **pass the current year explicitly** — PORTED from OpenCode's search prompt. |
| 4 | **`web-fetch`** | Fetch a URL to text. | CALLED / ORIGINAL | Documented fetch tools where the provider has them. The **tool-selection heuristic** is PORTED from OpenCode: *"if another tool is present that offers better web fetching capabilities, is more targeted, or has fewer restrictions, prefer that tool instead."* Most clients get this wrong by describing the tool instead of steering selection. |
| 5 | **`fs`** | `read`, `write`, `edit`, `glob`, `grep`. Rooted at the session workspace. | PORTED (shape) · ORIGINAL (prompt) | **Tool set** matches OpenCode's MIT builtin set. **`edit` requires a prior `read` of that path this session** — that behavioural rule exists in OpenCode's prompt but is useless there, because a prompt is advisory. Clauro enforces it as **host state** (D33), so it actually holds. **All prompt wording is ours** (D39): the reference prompts contain first-party text verbatim, and MIT cannot relicense that. |
| 6 | **`compact`** | Summarise history. Triggered by the host at pressure, on overflow, or by the user. | ORIGINAL (as a tool — it isn't one) | **Never sent in the request schema** (D14). `/compact` is PORTED in name and behaviour from OpenCode's `/compact` (alias `/summarize`). The **trigger arithmetic** is PORTED from DeepSeek. **Everything about how it's applied to Anthropic is CALLED** — server-side compaction with a documented parameter. |
| 7 | **`bash`** | Run a host command. Off by default. | PORTED (runner seam) · ORIGINAL (consent) | The **runner** is PORTED from DeepSeek: process-group kill, output truncation with spill, child-environment credential scrub, fd 0 as `/dev/null`. Two specifics PORTED verbatim-in-spirit: the **model-facing tool exposes no `stdin` and no `env`** (shell syntax already covers both — duplicate parameters add surface without authority separation), and the env merge order is fixed with managed names last so a model can't displace them. The **consent model is entirely ours** and stricter than any reference: every command approved individually, nothing persisted. |
| 8 | **`question`** | The model asks you something. Single choice, multiple choice, or free text. | PORTED (D40) · ORIGINAL (D41–D43) | The **tool existing at all** is PORTED — OpenCode ships `question` in its builtin set, and DeepSeek ships an equivalent. **Everything else is ours**: inline rendering (both references take over the composer instead), one call per turn with a mandatory skip option, and refusal of secret-shaped prompts. This is the one place we knowingly disagree with every reference we studied. |

### 2.2 Surfaces and shell

| Feature | What it does | Tag | What we're mirroring |
|---|---|---|---|
| **Projects** | Named container: instructions, files, its own memory space, its own workspace directory. | MIRRORED | claude.ai Projects, whose own docs make the case for us — per-project memory isolation is what makes memory useful rather than a flat notepad. **Gemini's Gems are folded in** (D35): a Gem is a named set of instructions plus reference files, which is a project with no storage. One concept, not two. |
| **Memory Topics UI** | Settings → list of topics, each readable / editable / deletable. | MIRRORED | claude.ai's Topics list. Its help centre states the authority plainly: *"Fix something in one topic and the change applies to every conversation from then on."* |
| **Pause / reset / per-chat off** | Three separate memory controls, never one toggle. | MIRRORED | claude.ai, exactly. Collapsing them is the classic mistake: someone wanting a break does not mean to lose their memory. The per-chat toggle **locks after the first message** and shows a crossed-out icon — and *no icon at all* when memory is on. Absence as signal. |
| **Sensitive topics** | Off by default; a review notice above the composer on every save. | MIRRORED | claude.ai, including the "never stored even if asked" list. |
| **Incognito chats** | Ghost icon. Excluded from history, search, and memory. | MIRRORED | claude.ai — and it's the only feature on their **free** tier. ~15 lines of code, the highest trust-per-line in the whole catalogue. |
| **Artifact drawer** | Right-hand pane, collapsible, per-thread. | ORIGINAL | No first-party reference image exists anywhere. claude.ai's current artifacts are **hosted, versioned, org-scoped, and cannot be made public** — a different product. Our drawer is the local complement: zero network egress, no org, no hosting. |
| **Thinking effort** | Reasoning control per turn. | CALLED | Anthropic's `thinking.effort`. **Middleware normalisation is ours**: Anthropic thinking blocks and OpenAI reasoning tokens both become one `Thinking` shape (D54), because the transcript cannot branch on provider. |
| **Chat export** | Thread → HTML/Markdown. | MIRRORED | claude.ai share/export, minus the public link and the org. |
| **Themes** | Light / dark / system. | MIRRORED | Commodity. |
| **Hotkey + command palette** | Summon the window, drive it by keyboard. | ORIGINAL | Tauri-native. Not a research finding — a judgement that a desktop client is judged by this. |
| **BYOK keychain** | Your key, your machine. | CALLED | OS keychain via the `keyring` crate. Never in SQLite, never logged. |
| **Model catalogue** | 226 providers, fetched and cached. | CALLED | **`models.dev`** — MIT, live, and the same source OpenCode uses. **Never bundled**: 5.3 MB exceeds our entire binary budget. Since D117 it is limits-enrichment only, fetched lazily — the picker is gated on configured providers (D116). |
| **Provider setup** | One endpoint, one key, one model list per provider. | PORTED (picker gating) · MIRRORED (per-endpoint discovery) · ORIGINAL (keyring, TTL, enrichment) | Picker gating PORTED from OpenCode's connected-provider picker (`/connect` + `auth.json` → ours is keyring); per-endpoint model discovery behaviour MIRRORED from Open WebUI (observation-only, D103 — no code, no wording); keyring-per-provider storage, 3-day TTL with stale flags, and lazy enrichment are ORIGINAL. |
| **Streaming** | SSE, hand-rolled. | ORIGINAL | There is no official Anthropic Rust SDK (max version 0.0.8, last updated 2024) and both SSE crates are unmaintained. |
| **Transport retry** | Backoff on 429/5xx, respecting `Retry-After`. | MIRRORED | Standard practice. No agent-level retry concept — the loop only sees succeed or fail. |

### 2.3 Compaction — three paths, never a tool

| Path | When | Tag | Mirroring |
|---|---|---|---|
| **On-demand** | **Primary on Anthropic** (`D95`; the docs say *"use on-demand compaction wherever it is available"*). Runs in the background, supports keep-recent-turns and our own `instructions` (≤16,384 chars, `D75`), which is what `D16` wanted.
| **Threshold** | **Fallback on Anthropic** (`D95`) — where on-demand is unavailable. `compact_20260112`, one parameter on an ordinary request. | CALLED | Anthropic's own. Simplest path: no separate request builder, no strict swap protocol, none of the reject-set pitfalls. |
| *(merged into the row above)* | `/compact` maps here, and so does supplying our own summarisation instructions (≤16,384 chars) — which is how our checkpoint format reaches the server-side path. Beta header `compact-2026-09-04`. | | |
| **Client-side** | **Non-Anthropic providers only** (`D15`). *Not* as overflow recovery on Anthropic — a client-side summariser rewrites history mid-conversation, which is what the thinking prefix check rejects with HTTP 400, and BYOK means account age varies per user so it cannot be tested away. | PORTED | Trigger arithmetic and the two-trigger split are PORTED from DeepSeek. The **prefix-cache replay** is PORTED from DeepSeek's bug fix: the summarisation directive must be a *trailing user message*, not a system prompt, or the first token differs and the entire cached prefix is invalidated — paying prompt cost twice exactly when the conversation is largest. `tools` ride along even though the summariser never calls one. |

Which path applies is decided at **runtime** from `capabilities.compaction` on the Models API. No live
key needed to make that decision — which is why no open question requires one.

### 2.4 Deliberately not in v1

| Not in v1 | Why |
|---|---|
| General tool loop (parallel calls, retry caps, budget) | v1 runs one tool at a time. The general loop is v2. |
| Research / deep research | Needs 5+ tool calls over 1–3 minutes. That's **v2**, and it needs stage-shaped progress — Gemini's Plan → Search → Reason → Report, not a spinner. |
| Chat search, RAG for projects | Needs embeddings. **v3**, remote API, opt-in — a local model would triple the binary for a feature two releases out. |
| Structured semantic index | Only LibreChat does this, with no second implementation to validate the schema against. **v2 candidate.** |
| `attach` (copy a directory in, sync back) | Designed, not built. First thing added if `fs` proves too confined (D44). |
| Artifact versions, Preview/Code tabs, download | v2. The render core ships in v1; the polish waits. |
| Hosted-service traits (accounts, share links, channels, server automations, cross-user analytics) | Never. Not a hosted service (D104). |
| Parallel multi-model panes, sibling-branch history | Unplanned. Each needs its own D-number (D104). |
| Shared calendar | Never — sync and multi-user state (D107). A pure-local calendar stays unplanned. |
| Image-gen-as-tool | v2/v3 media (D107). |
| Standalone shared notes | Never — Projects plus memory Topics cover the local need (D107). |
| Eval-arena and ELO leaderboards | Never — leaderboards need crowds (D107). |
| Video-call | Never — same row as voice. |
| Voice, connectors/MCP, Chrome, Word, Cowork | Server-side, or a different product. |

---

## 3. Terminology

**What we call it · what it actually is · what the services we studied call it.**

### 3.1 Our concepts

| We call it | What it actually is | claude.ai | Gemini | OpenCode | DeepSeek | LibreChat |
|---|---|---|---|---|---|---|
| **Thread** | One conversation. The unit of history. | Conversation | Chat | Session | Session/run | Conversation |
| **Project** | Container for threads + files + own memory + workspace | Project | Gem / Canvas | — | — | — |
| **Compact** | Summarise old history to free context | Artifacts' "context management"; "Research" compaction | — | `/compact` (alias `/summarize`), `SessionCompaction.compactIfNeeded` | `dsh-compaction-basic`, `CompactionEngine` | `agents/compaction.ts` |
| **Checkpoint** | The summary text itself | "Summary" | — | `SUMMARY_TEMPLATE` output | `COMPACTION_INSTRUCTION` output | `findCheckpointSummaryPart` |
| **Boundary** | Index where the retained tail starts | — | — | (implicit in `recent`) | — | `boundary` field on the summary part |
| **Generation** | Counter proving compaction actually changed something | — | — | — | `replaceGeneration` | — |
| **Surface** | The exact message list that would be sent next | — | — | session messages | "durable surface" | snapshot |
| **Pressure** | Proactive trigger: context approaching the limit | — | — | `compactIfNeeded` | trigger `'pressure'` | — |
| **Overflow recovery** | Reactive trigger: provider rejected the request | — | — | `compactAfterOverflow` | trigger `'context-overflow'` | — |
| **Headroom** | Safety margin subtracted from usable context | — | — | `buffer` (20,000) | `headroomTokens` (65,536) | — |
| **Reserved** | Output allowance held back | — | — | `max(output, buffer)` | `reserved` | — |
| **Usable** | `contextWindow − reserved − headroom` | — | — | — | — | `contextBudget` |
| **Topic** | One remembered subject | Memory → Topics | — | — | — | — |
| **Artifact** | A live page rendered from the session | Artifact | Canvas | *(none — no renderer exists)* | *(none)* | *(none)* |
| **Drawer** | The right-hand pane artifacts render into | *(no equivalent — theirs is hosted)* | Canvas panel | — | — | — |
| **Question card** | Inline prompt the model raises | — | Guided Learning (related) | `question` tool | `tool-ask-user` | — |
| **Tool loop** | model proposes → host executes → `tool_result` | — | — | agent loop | Cordis agent loop | LangChain graph |
| **Run** | One assistant turn and its tool traffic | — | — | session/message | `runId` | `runId` |
| **Thinking** | Reasoning content | Extended thinking | Deep Think | — | — | — |
| **Usage** | Token accounting | — | — | `Token.estimate` | `ctx.tokenMeter` | `summaryTokens` / `usage.ts` |

### 3.2 Terms owned by the providers — what our field names actually are

These are the exact wire values, so nobody has to guess at a plan.

| Our field | Wire value | Notes |
|---|---|---|
| Memory tool type | `memory_20250818` | **We don't send this.** D51: our own tool, every provider. Anthropic's exists and auto-injects its own memory protocol. |
| Context-edit strategies | `clear_tool_uses_20250919`, `clear_thinking_20251015` | Ordering is **mandatory**: thinking-clearing must be listed **first**. |
| Beta headers | `context-management-2025-06-27`, `compact-2026-09-04`, `compact-2026-01-12`, `thinking-binding-controls-2026-08-01` | Sent as `anthropic-beta`. **`compact_20260112` is the strategy *type*, not a header** — the header is `compact-2026-01-12`. Confusing the two produces a rejected request. |
| Prefix-mismatch path | `thinking.block_binding.prefix_mismatch_behavior` | **Not top-level.** Sent top-level or without the beta header → HTTP 400. |
| Compaction block | content type `compaction`, `stop_reason: "compaction"` | Streamed as one start + one stop, **no deltas**. Send-back: block first, summarised messages **must** be removed, exactly one per request — and two of three failure modes raise **no error at all**. |
| Usage after compaction | `usage.iterations` | Top-level `input_tokens`/`output_tokens` are **zero**. |
| Dropped thinking signal | `input_transformations` on `message_start` | The **only** runtime signal that thinking blocks were dropped. On `message_start` and on the final `message_delta`. |
| Thinking signature | `signature_delta` | Sent just before `content_block_stop`. A persister stopping at `content_block_stop` replays thinking that fails verification. |
| Omitted thinking | `thinking.display: "omitted"` | One **empty** `thinking_delta`, then one `signature_delta`. On our v1 thinking-effort path, not hypothetical. |
| Capability probe | `capabilities.compaction` on the Models API | Decides threshold vs on-demand vs client-side, per model, with no live key. |
| Artifact media type | `application/vnd.ant.code` | Their type string. Ours is our own (D1). |
| Artifact tool (theirs) | `<antml:invoke name="artifacts">` + `ArtifactsToolInput` | **We don't send this.** Informational — it's why our schema resembles theirs. |
| Memory path prefix | `/memories` | We map it to the SQLite `key` column. |
| Model catalogue | `models.dev/api.json` | MIT, 226 providers, 5.3 MB. Fetched, never bundled. |

### 3.3 Where our names deliberately differ

| We say | They say | Why we differ |
|---|---|---|
| **Thread** | Session / conversation | "Session" collides with the SSH sense, and with DeepSeek's `session`. |
| **Compact** | Summarize / summarization | "Summarize" describes the mechanism; "compact" describes the intent. Also matches `/compact`. |
| **Question card** | Question tool / ask-user | Ours names the *rendering*, which is the part we decided differently. |
| **Run** | Turn / message / session | "Turn" is ambiguous across four sources. We key usage by `runId` precisely so a sibling run's summary isn't subtracted from ours. |
| **Surface** | History / messages / context | "Context" is the thing we're trying to *avoid* overflowing; the surface is the concrete list. Keeps D25's separation of policy from accounting legible. |

---

## 4. The honest summary of what we borrowed

**Called (documented API, nothing copied):** the memory tool's command set · server-side compaction ·
context editing · prompt caching semantics · thinking blocks and their signature rules · model
catalogues · the capability probe.

**Ported (MIT designs, our implementation):** OpenCode — the compaction reserve arithmetic, the
anti-drift re-feed, the guarded summary region, tool-output bounding at the return boundary,
removing denied tools from the request, the `/compact` command, the `question` tool's existence,
the web-search year line, the web-fetch selection heuristic. DeepSeek Harness — the 0.8 / 0.16 ratios
and two-trigger split, overflow recovery with bounded retries, the generation proof, the
prefix-cache replay, the command-runner seam with no `stdin`/`env` on the model tool, and the env
merge order. **Not** the structural-boundary traversal — D61 was corrected to arithmetic-first
with a landing-site legality check, because the `tool_call_id`-edge approach originates in
LobeHub, which D59 forbids porting from. LibreChat — the boundary marker, the
separate summary accounting channel, the pre-invoke marker, and the token-limits resolution shape.

**Mirrored (observed behaviour, rebuilt):** Projects · the Topics memory model and its three
controls · the crossed-out memory icon · incognito chats · chat export · thinking effort · the
concept of an artifact.

**Original (no precedent exists):** the artifact drawer as a local, zero-egress pane · the
`~/.clauros` workspace tree with opaque-ID paths · defining our own artifact tool instead of parsing
anyone's format · our own memory tool on every provider · per-invocation-only `bash` consent · a
client-side summariser built around prompt-cache reuse · disabling artifacts on a platform where the
sandbox can't be proven.