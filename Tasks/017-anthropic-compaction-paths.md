# Task 017 — Anthropic compaction paths

**Phase** 4 · **Depends** `016` · **Decisions** D14, D21, D22, D69, D74, D75, D81
**Contracts** §5, §2

## Failing tests first

- `capabilities.compaction` selects the path **with no live key**
- `threshold` when available; `on-demand` when only that is; client-side when `none`
- **Compaction and `context_management` cannot be combined** — assert it is structurally impossible
- `clear_thinking_20251015` is serialised **before** `clear_tool_uses_20250919`
- A compaction response yields `kind:'compaction'` with **no deltas**
- A send-back with the compaction block **not first** is rejected before it reaches the wire
- Two compaction blocks in one request is rejected before it reaches the wire
- **The two silent failure modes are caught client-side**

## Do

**Three paths, chosen at runtime** (`D81`):

1. **Threshold — `compact_20260112`, preferred.** One parameter on an ordinary request; the API
   decides when. This **removes** the whole of `D74`'s reject set (`stop_sequences`,
   `output_config.format`, `tool_choice any`/`tool`, trailing unresolved tool call 400, `max_tokens`
   headroom), **and** `D21`'s request branch, **and** `D69`'s strict swap protocol with its two silent
   failure modes. Where it is supported, it is simply less to get wrong.
2. **On-demand — `compact-2026-09-04`.** For `/compact`, and for supplying **our own `instructions`
   ≤ 16,384 chars** (`D75`) so the checkpoint format of `D16` applies to the server-side path too.
3. **Client-side** (`016`) when neither exists.

**`compact` is never a tool** (`D14`). `/compact` only.

**The swap protocol fails silently, so validate it ourselves** (`D69`):
- block goes **first** in `messages`
- the messages it summarises **must be removed** — otherwise `compaction_block_misplaced` 400
- **exactly one** compaction block per request
- **two of the three failure modes raise no error at all.** A client that skips validation corrupts
  its own thread silently. So: assert first-position and exactly-one **before** sending.

**Usage after compaction** (`D70`). Top-level `input_tokens`/`output_tokens` are **zero**. Read
`usage.iterations`. A footer reading 0/0 looks like a meter bug, not a protocol detail.

**A request that combines both parameters is a 400** (`D21`). Headers may coexist; the parameters may
not. Two builders that branch, never merge.

**Set `clear_at_least` meaningfully high** (`D22`). Clearing tool results **invalidates the cached
prompt prefix** — you pay a cache-write on every clear. Clearing 300 tokens to save 300 is a net
loss. `clear_thinking_20251015` must be serialised **before** `clear_tool_uses_20250919`.

## Acceptance criteria

- [ ] Path chosen from `capabilities`, no live key
- [ ] Threshold preferred wherever available
- [ ] On `on-demand`, our `instructions` are sent
- [ ] Combination of `compaction` + `context_management` impossible by construction
- [ ] Thinking-clearing serialised first
- [ ] Block-first and exactly-one validated **client-side**
- [ ] Usage summed across `usage.iterations` for billing; **last** iteration used for context size
- [ ] A threshold-compaction response is tested explicitly: top-level token fields are NON-zero there,
      so a client reading them gets a wrong number that looks right
- [ ] `compact` absent from the tool schema

## On-demand is the primary path (`D95`); threshold is the fallback

The docs say plainly: *"Use on-demand compaction wherever it is available."* So the branch order is:

1. **`capabilities.compaction` reports on-demand** → on-demand. `/compact` maps here, and so does the
   automatic trigger at `D82`'s threshold.
2. **Reports threshold only** → `compact_20260112` on ordinary requests.
3. **Neither** → client-side (`D58`, non-Anthropic only).

Failing tests first:

- [ ] A model reporting on-demand sends `compaction: {"type":"summarize"}`, **not** the
      `compact_20260112` context-management edit. The capability probe decides; there is no preference
      ordering in the code (`D95`).
- [ ] `/compact` on an on-demand model issues one compaction request and swaps the block in per `D69`.
- [ ] Our own `instructions` (≤16,384 chars, `D75`) are sent with the on-demand request, and a request
      exceeding 16,384 is rejected **client-side** with a clear error rather than sent and 400'd.
- [ ] A model reporting threshold-only takes the threshold path and never sends a compaction request.
- [ ] **`compaction` and `context_management` are never combined in one request** (`D21`) — asserted on
      every branch, since this is the mistake the branch split invites.
