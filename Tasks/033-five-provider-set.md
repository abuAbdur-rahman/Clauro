# Task 033 — Five-provider set (OpenRouter, AgentRouter, Ollama, Google, Custom)

**Phase** follow-up of `003` · **Depends** `003` · **Decisions** D125
**Contracts** §1 (`provider`, `provider_model`), §5 adapters

**Status: implemented 2026-10-11 on Windows/WebView2 host.** `cargo test --lib`
(80 passed), full `vitest` (473 passed, two consecutive green runs after one
flaky 5-failure run in unrelated timing-sensitive UI tests), `tsc --noEmit`
and `eslint src` green. Live-key proof against real endpoints is **not**
verified by rule (no test may use a live key) — the keyless-Ollama path is
proven at its pure seams plus command wiring, not against a socket.

## Acceptance criteria

- [x] `cargo test` providers + turn suites green (new keyless tests included) —
      `src-tauri/src/providers.rs:795` (five builtins), `:801` (ollama `/v1`
      root), `:824`/:833 (agentrouter/google roots), `:899` (blank-key rule),
      `:908` (no auth on blank), `src-tauri/src/turn.rs:1423` (wire omits
      auth); full lib 80/80
- [x] `vitest` providers suites green (presets, detection, save routing, key
      rule) — `src/features/providers/providers.test.ts:133` (presets),
      `ProvidersView.test.tsx:237` (autofill), `:282` (builtin save),
      `:302` (custom save); targeted 36/36, full suite 473/473
- [x] `tsc --noEmit`, `eslint src` green — clean on final runs (one transient
      `ChatView.tsx` unused-var error appeared mid-work in a file this change
      never touches; gone on rerun, no edit made)
- [x] `grep -ri 'api[_-]?key\s*='` finds nothing new — added-lines check over
      the full diff is empty; the only repo matches are the two pre-existing
      `let api_key = keyring_store::retrieve` bindings (keychain reads, same
      bar as 003)
- [x] AgentRouter models without models.dev coverage stay unselectable
        (D117 rule, unchanged) with the honest notice — rule lives at
        `src/components/ModelPicker.tsx:116-124`, covered by the existing
        `unknown()` case in `src/components/ModelPicker.test.tsx:50`; this
        change neither weakens nor re-proves it
- [x] CONTRACTS §1 builtin names + D125 recorded in the same commit —
      `CONTRACTS.md:218`, `DECISIONS.md` D125

## Failing tests first

- `builtins()` returns exactly `[openrouter, agentrouter, ollama, google]` with
  their roots (https everywhere except Ollama's loopback).
- Keyless Ollama: blank key accepted in `provider_set_key` / `provider_refresh`
  / `turn_start` / `question_answer` for the `ollama` row only; no auth header
  sent when the key is blank; blank key still rejected for keyed providers.
- FE: presets match BE roots, `typeForRow` detects `agentrouter.org` /
  `generativelanguage` / `11434`, builtin-save routes the four ids, blank key
  valid only for `ollama`.

## Do

**BE (`src-tauri/src/providers.rs`).** `builtins()` → `openrouter`
(`https://openrouter.ai/api/v1`, kept), `agentrouter`
(`https://agentrouter.org/v1`), `ollama` (`http://localhost:11434/v1`),
`google` (`https://generativelanguage.googleapis.com/v1beta/openai`).
`provider_add_custom` unchanged — the fifth provider.

**Keyless Ollama.** `fetch_live_models` skips bearer auth on a blank key;
`provider_set_key` / `provider_refresh` accept a blank key only for the
`ollama` row; compat wire omits the `authorization` header on a blank key.
Every other provider keeps blank-key rejection.

**FE (`providers.ts`, `ProvidersView.tsx`).** `PROVIDER_TYPES` →
`openrouter/agentrouter/ollama/google/custom` with presets mirroring BE;
`typeForRow` + builtin-save branch follow the four ids; key rule stays
"required except ollama".

**Seed.** `src/mock/seed.ts` Ollama demo row root fixed to `/v1` (the old root
would 404 in mock parity too). The `openai`/`anthropic` demo rows stay — seed
is demo data for the harness, not the builtin registry, and its own test pins
it (`mock-tauri.seed.test.ts:28`).

## Provenance

- AgentRouter as OpenAI-compatible at `https://agentrouter.org/v1` with bearer
  auth: behaviour MIRRORED from OpenCode's custom-provider pattern (OpenCode is
  a permitted source; no code reused, implementation ours). Live-turn quirks
  observed in community reports (client fingerprinting, malformed `data: null`
  SSE chunk) are a documented limitation, not handled here.
- Google OpenAI-compat root: vendor doc fact (Google AI docs).
- Ollama `/v1` compat root: vendor doc fact.
