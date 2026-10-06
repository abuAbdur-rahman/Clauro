# Porting and attribution

**Ref: `AGENTS.md` §4.** Split out of `AGENTS.md` on 2026-10-06. This project borrowed, and honesty
about it is a requirement.

**Three MIT sources may be ported:** OpenCode (`anomalyco/opencode`, `dev`), DeepSeek Harness
(`deepseek-ai/deepseek-harness`, `master`), LibreChat (`LibreChat-AI/LibreChat`, `main`).

**One repo is observation-only and nothing may be taken from it:** LobeHub. Its licence requires a
commercial agreement for any derivative work and reserves unilateral amendment. Clauro is MIT, so
LobeHub's code, prompts and wording are all off limits. Behaviour may be described as evidence.
**D59, D60.**

**One more repo is observation-only:** Open WebUI, kept locally at `D:\oss\reference\claude`
(relocated 2026-10-04; formerly `D:/oss/open-webui`). Its custom Open WebUI License carries a
branding-preservation clause — removing "Open WebUI" branding over 50 end users without permission
is a material breach — so nothing may be ported: no code, no prompts, no wording, no component or
class names. Behaviour may be mirrored in our own words with our own implementation. **D103.** A
Rust stack does not waive this; reimplementation can still be derivative.

**Anthropic's first-party material is proprietary.** Behaviour may be mirrored. **No wording may be
reused** — including documentation quotes. **D39.** If you catch a verbatim quote from their docs in
this repo, that is a bug; paraphrase it and cite the URL.

**Two MIT repos contain proprietary prompt text inside them.** OpenCode's `read` and `edit` prompts
carry first-party wording verbatim; MIT cannot relicense it. Our `fs` prompts are written from
scratch. Behaviour is borrowed, wording is ours.

**Every port carries attribution** in the file it lands in. `FEATURES.md` tracks which is which.
If you cannot say which of the four tags a change is, it is not ready to merge.

## Escalation

Two of these are hard stops that also appear in [`escalation.md`](escalation.md) (§8): **taking
anything from LobeHub, ever**, and **taking anything from Open WebUI beyond behaviour-mirroring.**
If either looks like the only way forward, it is not.