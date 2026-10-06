# Adding a feature

**Ref: `AGENTS.md` §7.** Split out of `AGENTS.md` on 2026-10-06.

1. **Does it belong?** Check `MISSION.md` §"What it is not". If it only makes sense inside a coding
   workflow, it does not ship.
2. **A decision exists?** If it is non-obvious, it needs a D-number *before* code. Not after.
3. **A contract exists?** If a test can assert it, `CONTRACTS.md` needs the shape first.
4. **A task exists?** Write `Tasks/NNN-slug.md`. No code without one.
5. **Ported or original?** Tag it. If ported, cite the repo and commit — see
   [`licensing-and-attribution.md`](licensing-and-attribution.md) (§4) for which sources may be
   ported and which two are never.
6. **Does it change a security claim?** If yes, update `MISSION.md` §"the four claims" and
   `DESIGN.md` §3 in the same commit.

## Related

- Write the failing test first — [`testing.md`](testing.md) (§6).
- Step 1 is a filter, not a formality: if it fails, stop rather than proceeding with steps 2–6.