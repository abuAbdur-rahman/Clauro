# Task 016 — Client-side compaction (non-Anthropic)

**Phase** 4 · **Depends** `015`, `007` · **Decisions** D13, D16, D17, D18, D57, D58, D61, D63, D64, D65, D70
**Contracts** §4, §1, §2

**Non-Anthropic providers only** (`D58`). Anthropic gets server-side (`017`). **Never on Anthropic**
(`D15`) — the thinking prefix check returns HTTP 400 for accounts created on/after 2026-08-31, and
because Clauro is BYOK, account age varies per user, so it cannot be tested away.

## Failing tests first

- `pressure` fires at the computed trigger; below it, returns `null` without a model call
- **`context-overflow` bypasses thresholds entirely** — prune first, remeasure, then summarise
- Pruning alone can return `pruned` **without** a summary call
- **No assistant `tool_use` is ever separated from its result** across the compaction boundary `D61`
- A summariser returning identical text → `no-progress`, which **cannot authorise a retry**
- The summarisation request is a **byte-identical prefix** plus one trailing message `D13`
- `tools` are carried through even though the summariser never calls one `D13`
- The summariser cannot call a tool (instruction + absence of schema)
- Usage after compaction is read from `usage.iterations` `D70`

## Do

**Two triggers, one meter** `D12`. `pressure` is measured **at a turn boundary**, after a successful
call — never mid-call. `context-overflow` is the reactive path when the provider rejects the request.

**Fold structurally, not arithmetically** (`D61`). Measure first over the whole surface, then fold
walking backward accumulating tokens, and **land only on a balanced boundary** — keep folding until an
assistant `tool_use` is never separated from its result.

> Arithmetic decides *where*. **Structure decides whether that spot is legal.**

**The prefix-extension trick** (`D13`) — the best single finding of the research. Compaction fires
right after the loop **warmed the KV cache**. A summariser `system` prompt makes the first token
differ, which invalidates the **entire cached prefix**, so full prompt cost is paid **twice** —
exactly when the conversation is largest. Fix: put the directive in a **trailing user message**,
replay `system` + `tools` + messages verbatim, and **carry `tools` through** even though the
summariser never calls one — dropping them misaligns every following token.

**Fixed-section checkpoint** (`D16`). Ordered sections, empty sections kept, terse bullets, exact
paths and identifiers preserved, and *"Do not mention the summary process or that context was
compacted."* Two more rules in the trailing instruction: do not mention the summarisation request,
and output only the checkpoint text.

**Boundary marker + generation counter** (`D63`). Resolving a checkpoint **slices from the marker
onward**, so parts emitted after a mid-run summary survive. Compaction is real **only if the
generation advanced**. Two independent MIT implementations agree (LibreChat for the boundary,
DeepSeek for the proof) — together they make `D17` enforceable rather than heuristic.

**Usage on a separate channel** (`D57`). `summary_tokens` and `summary_used_tokens`, never folded.

## Acceptance criteria

- [ ] Both triggers behave as specified
- [ ] Never invoked for an Anthropic model — enforced by a test
- [ ] No unbalanced tool boundary, verified by a fixture that tries to produce one
- [ ] `no-progress` cannot authorise a retry
- [ ] Prefix identical; one trailing message; `tools` present
- [ ] Summariser cannot call a tool
- [ ] `seq` gaps appear and are tolerated
- [ ] `generation` monotonically non-decreasing
- [ ] `usage.iterations` used post-compaction
