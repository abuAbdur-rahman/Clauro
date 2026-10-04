# Task 007 — Tool registry and permission resolution

**Phase** 2 · **Depends** `006` · **Decisions** D26, D27, D39, D51, D55
**Contracts** §3

## Failing tests first

- A denied tool is **absent from the serialised request**, not filtered from results
- `resolve()` — `deny` beats `allow` regardless of rule order
- `resolve()` — the most recent matching rule wins
- Every handler returns a `ToolOutcome`; **nothing throws**, including on invalid input
- A handler returning 5 MB of output stores all of it and previews a bounded slice
- `previewPath` re-read returns byte-identical content

## Do

**Registry.** `materialize()` → definitions + `settle()`. Each registration carries an identity
object captured at materialise time; a mismatch returns `{type:'error', value:'Stale tool call'}`.
That directly serves `D19`'s frozen tool list.

**Permissions — the part that matters.** A denied tool is **removed from the request entirely**, so
it cannot be called, cannot confuse the model through its description, and cannot be socially
engineered into being called. `D26`.

Split the provenance honestly:
- **PORTED (OpenCode):** `whollyDisabled()` → `registrations.delete(name)`, and `findLast()` —
  most recent rule wins.
- **ORIGINAL:** the three-way `deny → ask → allow` precedence. This exists in **neither** MIT
  reference. It is ours because the order fails closed: a wrong match still lets `deny` win.

**Output bounding on the way out.** Full output → `full_path`. Transcript gets a bounded `preview`
plus `previewPath` so the model can re-read. `D27`. Strictly better than truncating at write time,
which loses data permanently.

**All descriptions are ours, written from scratch.** `D39`. Two MIT repos carry first-party prompt
text verbatim inside them; MIT cannot relicense it. Behaviour is borrowed, wording is ours.

**Clauro defines its own `memory` tool** rather than sending Anthropic's `memory_20250818`, so
memory works on every provider. `D51`. We give up the API's auto-injected protocol and write the
equivalent ourselves — one code path, one test surface.

## Acceptance criteria

- [ ] Denied tool absent from the request body
- [ ] `deny` wins over `allow` in every ordering
- [ ] Most recent rule wins
- [ ] Zero throws across the tool boundary, including on malformed input
- [ ] 5 MB output fully stored, preview bounded, re-read identical
- [ ] Stale tool call detected
- [ ] No description text matches any reference implementation's wording

## Tool availability is a first-class output of this task (`D94`)

`materialize()` now takes per-thread permission state as well as project permissions, because on the
Claude API the effective tool set changes **without** editing the `tools` array.

Failing tests first:

- [ ] Every tool is emitted in the first request's `tools` array; unavailable ones carry
      `defer_loading: true`. **Assert no tool is ever added to or removed from that array afterwards.**
- [ ] Granting `bash` mid-thread produces a `tool_addition` block naming it — **not** a rewritten
      request, and **not** a new thread (`D94`).
- [ ] Revoking produces `tool_removal`.
- [ ] A `role: "system"` message carrying a tool change is **append-only**: the test attempts to move,
      reword and delete one, and asserts all three are rejected (`D94` — it joins the prefix).
- [ ] On the OpenAI-compatible adapter the same scenario instead freezes the array and the thread
      cannot change its tool set. **Both behaviours are asserted**, because they differ on purpose.
- [ ] A denied tool is absent from the serialised request (`D26`), *not* merely filtered from results.
