# Task 009 — Question tool

**Phase** 2 · **Depends** `007` · **Decisions** D40, D41, D42, D43
**Contracts** §2, §3

## Provenance, stated up front

- **D40 is PORTED** — OpenCode ships `question` in its builtin set.
- **D41, D42, D43 are Clauro-ORIGINAL.** Audit 2 found the per-turn cap and the secret refusal exist
  in **no** reference implementation.

## Failing tests first

- A second `question` call in one assistant turn is refused as a `tool_result`
- A secret-shaped prompt is refused, and the refusal is **silent to the model**
- The answer arrives as an ordinary `tool_result` and lands in the append-only log
- The card survives compaction with no special handling
- "Skip / decide for me" is present on every card

## Do

**First-class tool, not prose** (`D40`). Answer returns as an ordinary `tool_result`, which is why it
survives compaction untouched — the same property that makes the memory tool work.

**Inline, never a modal** (`D41`). A modal breaks the stream and throws away scroll position. Inline,
the turn visibly pauses at the point of the question, which is also the honest description of what is
happening.

> **Both MIT references do the opposite.** OpenCode docks to the composer
> (`session-question-dock.tsx`); DeepSeek puts a card in the bottom `min(60vh, 520px)`. **This is a
> deliberate divergence** — the one place we knowingly disagree with every reference we learned from.
> Do not "fix" it toward the references.

**One call per assistant turn, always offering skip** (`D42`). A model with an unlimited question
tool will stall a session and spend tokens on repeated clarification. The cap plus an always-present
escape makes it an affordance rather than an interrogation. A model that ignores the cap and loops is
a bug to degrade from, not one to invite.

**Never carries secrets** (`D43`). The card is durable — it survives compaction *and export*, so it
is a channel for persisting credentials into files that get synced and shared. Refuse silently; the
question fails as a typed `tool_result`.

## Acceptance criteria

- [ ] One question per turn, enforced
- [ ] Skip always offered
- [ ] Answer is an ordinary `tool_result` in the append-only log
- [ ] Card survives compaction unchanged
- [ ] Secret-shaped prompts refused
- [ ] Renders inline; scroll position preserved across the pause
