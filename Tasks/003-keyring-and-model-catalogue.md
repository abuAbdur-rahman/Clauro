# Task 003 — Keyring and model catalogue

**Phase** 0 · **Depends** `002` · **Decisions** D23, D49, D50, D53, D76
**Contracts** §5 `ProviderAdapter.limits`, §5 model catalogue shapes

**Status: verified 2026-10-04 on Windows/WebView2.** `cargo test` (11 shell tests + workspace),
`vitest` (17), `tsc`, `eslint strictTypeChecked` all green; picker verified live against the real
`models.dev` catalogue (8,158 models after filtering). Caveats where a live path could not run on
this host: the *missing*-WebView2 path and the *libsecret-absent* path are proven by unit tests only
— Linux CI and a runtime-less machine exercise them for real.

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
- [x] Unknown model → typed notice, picker still usable — `resolveLimits({})` → `UnknownModel`;
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
