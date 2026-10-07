# Task 003 — Keyring and model catalogue

**Phase** 0 · **Depends** `002` · **Decisions** D23, D49, D50, D53, D76, D116, D117
**Contracts** §1 (`provider`, `provider_model`), §5 `ProviderAdapter.limits`, §5 model catalogue shapes

**Status: verified 2026-10-04 on Windows/WebView2, and on Linux CI.** `cargo test` (13 shell tests +
workspace), `vitest` (17), `tsc`, `eslint strictTypeChecked` all green; picker verified live against
the real `models.dev` catalogue (8,158 models after filtering). The first CI run on Linux failed the
keyring test — the crate's typed `Error::NoDefaultStore` (platform store init failed: no session bus
on a runner) was classified as `Failed` by a string match. Fixed test-first: `entry()` now consults
`Entry::store_status()` and `classify()` matches the typed variant, so the libsecret-absent path is
proven both locally and on both Linux CI jobs. The missing-WebView2 path remains unit-test-proven
only — it needs a machine without the runtime.

**PR #2 review (CodeRabbit, 2026-10-04): eight findings, all verified against the code before fixing.**
Two were code, fixed test-first: `resolveLimits` takes the ref it is resolving (the hardcoded
`anthropic/mystery` placeholder violated §5's `UnknownModel` — the caller must name the real model),
and `catalogue_refresh` degrades an unreadable cache to no-cache (`cache_or_none`) instead of
aborting on the fallback it merely consults. Two were CI: every action pinned to a full commit SHA
(CWE-829) and detection guards moved *before* the setup actions that read repo files. Four were stale
claims: README status block, `TECH_STACK.md` §5 runner label, the lucide maintenance record, and the
verdict doc citing `package-lock.json` after the pnpm conversion.

## Failing test first

- Keychain round-trip: write → read → delete → read returns absent.
- `resolve_limits` falls back correctly through the chain
  `conversation → adapter spec → server-resolved`.
- An unknown model ID yields a typed notice, **not** a panic.
- A failed `models.dev` fetch yields cached data, **not** a broken model picker.

## Do

**Keyring.** `keyring` crate only. Windows Credential Manager, libsecret on Linux. **Never** SQLite,
never a config file, never a log line. Add a test asserting no key material reaches any other sink.

**Catalogue.** `https://models.dev/api.json` — MIT, 226 providers, ~5.3 MB. **Fetch at runtime and
cache. Never bundle** — it is larger than the entire binary budget.

Cache policy: fetch once, cache with a TTL, fall back to cache on failure. On Linux, libsecret may be
unavailable on a headless box — detect it and report it honestly rather than failing silently at
first use.

**WebView2.** Evergreen bootstrapper, ~1.5 MB, needs network on first run. Accepted with the
tradeoff recorded: it fails on the locked-down machines where a local-first tool is most
attractive. `D49`. Therefore **detect a missing runtime before first paint** and explain it —
never a blank window, never a bare crash. `D53`.

## Acceptance criteria

- [x] Key stored, retrieved, deleted; **no key material in SQLite, files, or logs** — round-trip
      test runs against the real Windows Credential Manager; `errors_carry_no_secret_material`
      locks the type; `grep 'api[_-]?key\s*='` finds nothing
- [x] `models.dev` fetched, cached, survives an offline start — TTL cache written to app-data;
      `resolve` prefers fresh, falls back to cache, returns honest-empty without error (unit-tested)
- [x] Offline start shows cached models — `catalogue_refresh` failure path returns `state: "cached"`
      with the fetch error as a notice; picker renders it
- [x] Unknown model → typed notice, picker still usable — `resolveLimits(ref, {})` → `UnknownModel`;
      picker sets a notice instead of throwing
- [x] Missing WebView2 → explained before first paint — boot gate renders the hint before the UI;
      `map_webview_result` tested (live path needs a machine without the runtime)
- [x] libsecret-unavailable detected and reported — `KeyringError::Unavailable` typed, classified
      from backend absence; test asserts the honest path (live path runs on Linux CI)
- [x] `grep -ri 'api[_-]?key\s*='` finds nothing — pass, 2026-10-04, working tree
- [x] **Model picker lists every catalogue model with its limits**, and selecting one writes only
      `thread`-level state — the thread stays open, `tools_frozen` untouched (`D19`) — verified
      live; `thread.test.ts` asserts the thread stays open
- [x] **Per-thread model switch is allowed mid-conversation**; switching on Sonnet 5.5 warns that
      prior thinking blocks are account-bound and will be dropped, but does not block the switch —
      `switchWarnings` tests (warns on reasoning→reasoning, silent on same/plain)
- [x] **Thinking-effort control** (`D76`) sets `effort` / `thinking.display` as request parameters
      only — changing it must **not** alter the system-prompt hash, and a test asserts that
      (`effort vs system prompt` suite; the request builder itself arrives with 005/006)
- [x] Effort change takes effect on the next turn and does not retro-edit stored blocks —
      `thread.test.ts` asserts `promptHash` and stored state survive `setEffort`

**Addendum 2026-10-07 (providers, D116/D117).** The catalogue outgrew this task's original shape:
showing 200+ providers when zero keys exist is an overload no fetch policy fixes. What changed:

- **Store:** `provider` + `provider_model` tables (now fourteen tables; `schema.rs` updated),
  v1→v2 migration (`tests/providers.rs`: CRUD, replace-semantics, cascade removal, migration —
  8 tests). `provider.models_fetched_at` joins the CONTRACTS §1 mutable list and the
  `append_only.rs` allowlist.
- **Commands** (`src-tauri/src/providers.rs`, 18 tests): `provider_list`, `provider_add_builtin`
  (anthropic/openai/openrouter), `provider_add_custom` (validated id + URL), `provider_remove`
  (key first, then rows), `provider_set_key` (stores key, proves it against live `/models`,
  rolls the key back on failure), `provider_models` (stored + stale flag), `provider_refresh`,
  `provider_models_enriched` (one-invoke join with lazy models.dev enrichment, 7-day TTL).
- **Turn integration:** `turn_start` reads the provider row — unknown id is `NoProvider`,
  Anthropic is live, OpenAI-compatible rows are `UnsupportedProvider` until the request
  translator lands (the loop builds Anthropic-shaped bodies; sending one at a chat-completions
  endpoint would be a silent 400 — refused here instead).
- **UI:** `ProvidersView` (add/key/refresh/remove, 6 tests), `ModelPicker` re-sourced to
  configured providers only with unknown-limits models unselectable (6 tests), boot no longer
  fetches anything, providers view wired into `App`.
- **Still honestly open:** the live-key proof (no key on this host — `provider_set_key` and
  `provider_refresh` are untested against a real endpoint by rule), the OpenAI request
  translator, and per-model limits for custom endpoints (owned by the translator slice, which
  needs them for the request anyway).
