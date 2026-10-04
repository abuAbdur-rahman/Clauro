# Task 023 — Turn loop and system prompt

**Phase** 2 · **Depends** `006`, `007` · **Blocks** every tool task · **Decisions** D7, D11, D19, D27, D39, D55, D65, D67, D68, D76, D85
**Contracts** §2, §3

> Added by audit 4 finding 6. The loop that drives the registry, and the prompt every tool depends
> on, had no owner. **Read this before `008`–`014`** — those tasks each implement a handler, and the
> loop is what calls them.

## Failing tests first

- A fixture that emits two sequential `tool_use` blocks runs to `end_turn`, dispatching both, in order
- Two `tool_use` blocks in **one** assistant message are dispatched **serially**, and the second
  result appears after the first — v1 has no parallel calls
- The user stops mid-loop: **every** dispatched call gets a result, including the cancelled one (`D65`)
- A turn that stops mid-call keeps its completed work and the partial assistant turn (`D68`)
- `thread.system_frozen` hash is identical across every turn in a thread
- The hash **changes** when the tool list changes — which is why enabling `bash` opens a fresh
  thread (`D19`, `D67`)
- Thinking effort, `max_tokens` and `tool_choice` vary **without** changing the prompt hash (`D76`)
- A handler that throws is caught and becomes a typed error result; the loop continues (`D55`)
- A transport failure terminates the loop with a typed error in the transcript, not a hung turn
- **No system-prompt string matches wording from any reference implementation** (`D39`)
- A prompt that mentions `/memories` says what Clauro wants said, in Clauro's words (`D7`, `D11`)

## Do

**The loop.** Stream the response. On a `tool_use` block, dispatch through the registry
(`Tasks/007`), bound the output on the way out (`D27`), append the result, re-send. Repeat until the
assistant returns no `tool_use`, or the user stops. Serial dispatch only — parallel calls, retry
caps and budgets are v2's general tool loop and are the one thing v1 omits.

Nothing crosses the boundary as an exception (`D55`). A handler that cannot proceed returns
`{status:'error', message}`, the model sees it and decides what to do next. A non-zero exit from
`bash` is `ok` with output attached, not an error.

**The system prompt.** Assembled once at the thread's first turn, hashed into
`thread.system_frozen`, never rebuilt (`D19`). It carries the tool inventory, the `fs` preconditions
(read-before-edit is enforced by host state, not by this sentence — `D33`), the output-bounding
behaviour, and **our own** memory protocol instruction.

**Two things this prompt must not contain.** Anything that varies per turn — thinking effort,
`max_tokens`, `tool_choice`, `metadata` — belongs in request parameters, not prompt text (`D76`).
And **no first-party wording, including documentation quotes** (`D39`). We write the memory protocol
ourselves and convey the same intent; that is a deliberate trade to get one memory code path
instead of two (`D51`, `D7`).

**Stop conditions.** `end_turn` · the user stopping · transport failure. **No budget cap in v1** —
there is no general loop to bound, and the context trigger (`D82`) is the real ceiling.

## Acceptance criteria

- [ ] A two-`tool_use` fixture runs to `end_turn` with both dispatched, in order
- [ ] Multiple blocks in one assistant message dispatch serially
- [ ] Stop mid-loop closes every dispatched call, cancelled included (`D65`)
- [ ] Completed work survives a mid-call stop (`D68`)
- [ ] `system_frozen` hash stable across turns
- [ ] Hash changes when the tool list changes (`D19`, `D67`)
- [ ] Effort / `max_tokens` / `tool_choice` vary without changing the hash (`D76`)
- [ ] A throwing handler becomes a typed error result; the loop continues (`D55`)
- [ ] Transport failure ends the loop with a typed error, never a hung turn
- [ ] Zero exceptions cross the tool boundary
- [ ] No prompt string matches any reference implementation's wording (`D39`)
- [ ] Memory protocol is Clauro's own text (`D7`, `D11`)

## Not in this task

Parallel tool calls · retry caps · budget caps (all v2's general loop, `ROADMAP.md` §v2).
The **registry and permission resolution** live in `Tasks/007` — this task consumes them.