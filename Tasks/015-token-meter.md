# Task 015 — Token meter

**Phase** 4 · **Depends** `006` · **Decisions** D25, D64 · **Contracts** §4

**Scheduled *after* the tools, which looks backwards and is not.** Every tool writes to the log and
therefore moves the pressure number. Building the meter against a real transcript is the only way to
know the estimator is calibrated; a meter written against a mock drifts silently.

## Failing tests first

A table-driven test over `(contextWindow, maxOutputTokens, headroomIn)` asserting **D82**:

```
headroom    = min(headroomIn, 65_536, 0.25 x contextWindow)
reserved    = min(max(maxOutputTokens, 20_000), 0.50 x contextWindow)
ratioBound  = 0.8 x contextWindow
usableBound = contextWindow - reserved - headroom
trigger     = max(2_048, min(ratioBound, usableBound))
```

Three properties, each a real bug we would otherwise ship. **Every expected value below is computed
from that formula by the test itself, not asserted by hand** — the test recomputes each row and
fails if the table and the function disagree.

| contextWindow | maxOutput | headroomIn | reserved | headroom | ratioBound | usableBound | **trigger** | why it matters |
|---|---|---|---|---|---|---|---|---|
| 200,000 | 128,000 | 65,536 | 100,000 | 50,000 | 160,000 | 50,000 | **50,000** | the proportional caps bind: a 128k output allowance and a 65,536 headroom do not fit a 200k window together |
| 200,000 | 8,000 | 65,536 | 20,000 | 50,000 | 160,000 | 130,000 | **130,000** | the ordinary case |
| 1,000,000 | 128,000 | 65,536 | 128,000 | 65,536 | 800,000 | 806,464 | **800,000** | 1M window — the ratio bound wins and the caps do not bind at all |
| 32,000 | 4,096 | 0 | 16,000 | 0 | 25,600 | 16,000 | **16,000** | small model, `reserved` capped at 50% of the window instead of swallowing it |
| 8,192 | 2,048 | 0 | 4,096 | 0 | 6,554 | 4,096 | **4,096** | **a local model.** Under D64 this produced a trigger of zero or below; the caps and the floor are what keep it positive |
| 16,000 | 4,096 | 65,536 | 8,000 | 4,000 | 12,800 | 4,000 | **4,000** | oversized headroom against a small window — headroom capped at 25% instead of exceeding the window |

**Guard:** if any row reports a trigger `<= 0`, a trigger `> contextWindow`, a `reserved` above
`0.50 x contextWindow`, or a `headroom` above `0.25 x contextWindow`, one of the proportional caps or
the 2,048 floor is missing. **This test is the reason D82 exists** — under the previous formula
every model below an 85,536-token window produced a negative trigger, which is the entire local-model
class the OpenAI-compatible adapter exists to serve.

Also: a negative or absurd `maxOutputTokens` clamps rather than panics. Unknown model -> typed notice.

## Do

`TokenMeter.measure()` → `Measurement`. **Policy receives intent, never arithmetic** (`D25`).

```
headroom    = min(headroomIn, 65_536, 0.25 × contextWindow)
reserved    = min(max(maxOutputTokens, 20_000), 0.50 × contextWindow)
ratioBound  = 0.8 × contextWindow
usableBound = contextWindow − reserved − headroom
trigger     = max(2_048, min(ratioBound, usableBound))
```

**Both bounds, plus caps and a floor.** Each failure mode is real: a large-output model on a modest
window overflows before a ratio fires, and an over-eager bound compacts constantly. DeepSeek already
takes the `min`; we keep both. `D64` is then **superseded by `D82`**, which adds three things D64
lacked: `buffer` finally has a value (20,000, from OpenCode, MIT), every reserve term is capped
proportionally so a constant can never exceed a small window, and the result is floored at 2,048 so
the trigger is always positive. **Use the D82 formula above.**

**`CompactionResult` gets a `no-progress` variant** — `committed | pruned | no-progress`. It exists so
that *"the summariser returned but changed nothing"* is representable. **Without it, `D17`'s
anti-thrash breaker is a heuristic. With it, it is enforceable.**

Estimates are estimates. Where the provider returns real usage, store it (`usage.iterations`) and
prefer it.

## Acceptance criteria

- [ ] All four table cases pass
- [ ] Negative/absent `maxOutputTokens` clamps
- [ ] Unknown model → typed notice
- [ ] Policy receives a trigger, never a token count
- [ ] `no-progress` is a real variant, not a comment
- [ ] No policy code performs arithmetic on tokens
