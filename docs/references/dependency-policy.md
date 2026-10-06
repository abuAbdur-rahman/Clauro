# Adopt the wheel. Record the reference.

**Ref: `AGENTS.md` §5a.** Added to `AGENTS.md` 2026-10-04; split into this file 2026-10-06.

The instinct to hand-roll is the expensive one, and it is the one this project is most likely to
indulge because it feels like diligence. It is not. A hand-rolled text diff is a bug farm with a nice
UI.

**Before writing anything non-trivial, search for the library that already does it.** Both
registries: `npm view`, and `crates.io/api/v1/crates/<name>`. This applies to parsing, diffing,
watching a filesystem, and every algorithm someone else debugged for a decade.

**Then vet it, and write down what you found.** A dependency nobody can reconstruct six months from
memory is a dependency nobody dares remove. Every adopted dependency records:

1. **Name, version, licence.** Must be MIT/ISC/Apache-2.0/CC0-compatible with our MIT licence.
2. **The URL** — repo or registry page.
3. **The alternative rejected, and why.** This is the part that matters. Without it the next person
   re-litigates the decision.
4. **The maintenance state as of the date checked.** Last release date, not download count —
   downloads reward abandonment. `eventsource-stream` has 25M downloads and died in 2022.

**Prefer the maintained thing over the popular thing.** Six stars with a release last month beats
six hundred thousand downloads with no release since 2022.

**A false claim in a spec is a bug.** When research invalidates something written down — the way
`reqwest-sse` invalidated "both SSE crates are unmaintained" — correct it in the same change and
keep the correction visible. Do not quietly rewrite history and do not leave the false claim standing.

**Research is not installation.** `TECH_STACK.md` §7.2 and `docs/dependencies.md` §5 list wheels that
were identified and vetted so the owning task does not re-research them. Nothing in those tables is
installed. Each still needs its own task and its own row before it lands.

**Scope discipline.** "We should use a library for this" is a claim to verify, not a licence to add
four. A dependency crossing the artifact sandbox or the tool host is a **security-surface change**,
not a convenience — see [`escalation.md`](escalation.md) (§8).

## Related

- `docs/dependencies.md` is the **evidence** — per-crate research with dates. This file is the
  **policy** that requires the evidence to exist.
- `AGENTS.md` §5 is the always-on half: no new dependency without a `TECH_STACK.md` §6 line saying
  why the obvious alternative was rejected.