# What needs a human, not an agent

**Ref: `AGENTS.md` §8.** Split out of `AGENTS.md` on 2026-10-06.

- **Changing a security claim.** `MISSION.md` §5 and `DESIGN.md` §3 are user-facing promises.
- **Disabling a feature on a platform.** `Tasks/001` may conclude that WebKitGTK will not hold an
  opaque origin. That is a release decision and the user is told in the product, not in a changelog.
- **Anything that raises the binary budget past ~25 MB.**
- **Taking anything from LobeHub.** Ever. If it looks like the only way, it is not.
- **Taking anything from Open WebUI beyond behaviour-mirroring.** The branding clause follows ported
  material. **D103.**
- **Renaming a decision.** D-numbers are permanent. Supersede, never renumber.

## Related

- The licensing reasons behind the two repo triggers are in
  [`licensing-and-attribution.md`](licensing-and-attribution.md) (§4).
- The platform trigger usually means a verdict table gains a Linux column — see
  [`windows-development.md`](windows-development.md) (§8a).