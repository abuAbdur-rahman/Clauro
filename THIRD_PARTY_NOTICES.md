# Third-party notices

Clauro is MIT-licensed (see `LICENSE`). It exists because other people published their work under
permissive licences, and attributing that is **a release requirement, not a courtesy** — **D60**. The
normative rule set is [`docs/references/licensing-and-attribution.md`](docs/references/licensing-and-attribution.md);
[`FEATURES.md`](FEATURES.md) §4 is the per-feature record of what came from where.

## Sources this project ports from

Every row below is MIT, and every row is a **design** we reimplemented in our own code. Attribution
also appears in the file each port lands in, as the rule set requires.

| Source | Repository | What was taken |
|---|---|---|
| **OpenCode** | `anomalyco/opencode` — https://github.com/anomalyco/opencode | The compaction reserve arithmetic, the anti-drift re-feed, the guarded summary region, output bounding at the tool-return boundary, removing a denied tool from the request, the `/compact` command, the `question` tool's existence, the web-search year line, the web-fetch selection heuristic, and the `fs` tool set's shape. |
| **DeepSeek Harness** | `deepseek-ai/deepseek-harness` — https://github.com/deepseek-ai/deepseek-harness | The 0.8 / 0.16 ratios and the two-trigger split, overflow recovery with bounded retries, the generation proof, the prefix-cache replay, and the command-runner seam: process-group kill, output truncation with spill, credential-scrubbed child environment, no `stdin`/`env` on the model-facing tool, and the fixed environment merge order. |
| **LibreChat** | `LibreChat-AI/LibreChat` — https://github.com/LibreChat-AI/LibreChat | The boundary marker, the separate summary accounting channel, the pre-invoke marker, and the token-limits resolution shape. |
| **shadcn/ui** | `shadcn-ui/ui` — https://github.com/shadcn-ui/ui | **Component code only** (**D127**): the vendored primitives under `src/components/ui` are copied and adapted in place. Nothing from this source informed a non-UI decision. |

## What is deliberately not here

- **No reused wording.** No prompt text, documentation quote, or prose from any source is copied.
  Where a source or a first-party document informed behaviour, the behaviour was rebuilt in our own
  implementation and described in our own words (**D39**). Two of the MIT sources carry first-party
  prompt text that MIT cannot relicense; our `fs` and `edit` prompts are written from scratch.
- **No first-party vendor material.** Anthropic's and Google's material is proprietary: behaviour may
  be mirrored, wording may not. A verbatim quote from their documentation in this repository is a
  bug — paraphrase it and cite the URL (**D39**).
- **No code, prompt or wording from two observation-only repositories.** One licence requires a
  commercial agreement for any derivative work and reserves unilateral amendment, so even a
  permissive reading today is not a stable grant (**D59**, **D60**). The other carries a
  branding-preservation clause, which a reimplementation does not waive (**D103**). Both are read
  for behaviour only and are named, with their reasons, in the rule set linked above — they are not
  sources of anything in this project, which is why they are not rows in the table.

## Runtime data, not a port

The model catalogue is fetched at runtime from **models.dev** (<https://models.dev/api.json>, MIT)
and cached locally. It is never bundled into the binary — at ~5.3 MB it is larger than the entire
binary budget (**D23**, **D117**). It is noted here so a reader of the shipped artefacts knows where
that data comes from.
