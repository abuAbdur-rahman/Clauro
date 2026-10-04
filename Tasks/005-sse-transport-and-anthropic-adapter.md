# Task 005 — SSE transport and the Anthropic adapter

**Phase** 1 · **Depends** `004` · **Decisions** D20, D21, D24, D48, D56, D69–D75, D80, D81
**Contracts** §5

## Failing tests first

Four fixtures, synthetic, **no live key**:

| Fixture | Asserts |
|---|---|
| `omitted_thinking.sse` | one empty `thinking_delta`, one `signature_delta`, block closes. `D73` |
| `compaction_response.sse` | usage comes from `usage.iterations`; top-level tokens are **zero**. `D70` |
| `dropped_block.sse` | `input_transformations` on `message_start` sets `dropped`. `D71` |
| `unknown_event.sse` | an unrecognised event yields `{t:'ignored'}` and parsing continues. `D80` |

Plus: an event split across a chunk boundary reassembles. Plus: `ping` keeps the connection alive,
`error` terminates with a typed error.

## Do

**Hand-rolled SSE over `reqwest`.** There is no official Anthropic Rust SDK (0.0.8, 2024-09-03) and
both SSE crates are unmaintained. We build on neither. `D24`.

**Four parser rules** (`CONTRACTS.md` §5) — each has a fixture above. **P4 is the one that ships
silently**: a usage footer reading 0/0 looks like a bug in the meter, not a protocol detail.

**Two 400s you will ship if you forget them:**
- `prefix_mismatch_behavior` is **not top-level**. Path is
  `thinking.block_binding.prefix_mismatch_behavior`, under the beta header
  `thinking-binding-controls-2026-08-01`. `D20`.
- **`compaction` and `context_management` cannot be combined on one request.** Headers may coexist;
  the parameters may not. Separate request builders that branch, never merge. `D21`.

**Retry.** Transport-level backoff on 429/5xx honouring `Retry-After`. No agent-level retry concept
— the loop only ever sees a request fail or a stream arrive. `D56`.

**Two adapters** (`D48`): Anthropic, plus one OpenAI-compatible adapter for everything else. The
transcript never branches on provider.

> **The recorded risk, stated plainly:** the OpenAI-compatible surface is validated against a
> third-party server, so coverage of real providers is an **assumption, not a test**. The dialect
> varies in streaming deltas, tool-call framing, and reasoning-token fields. **It degrades visibly** —
> an unrecognised event or an unmappable field becomes a `notice` block saying so. Never render a
> plausible-looking wrong transcript.

**Capability probe.** `capabilities.compaction` decides the compaction path at runtime. **No live
key is needed to choose.** `D75`.

## Acceptance criteria

- [ ] Four fixtures pass; all synthetic
- [ ] `cargo test` needs no network
- [ ] Events split across chunks reassemble
- [ ] Unknown event → `ignored`, stream continues
- [ ] `thinking.block_binding.prefix_mismatch_behavior` sent on the correct path with its header
- [ ] Compaction and context-management requests are structurally impossible to combine
- [ ] 429/5xx retried with backoff; `Retry-After` honoured
- [ ] OpenAI-compatible adapter renders an unrecognised event as a visible notice
