# Task 003 — Keyring and model catalogue

**Phase** 0 · **Depends** `002` · **Decisions** D23, D49, D50, D53
**Contracts** §5 `ProviderAdapter.limits`

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

- [ ] Key stored, retrieved, deleted; **no key material in SQLite, files, or logs**
- [ ] `models.dev` fetched, cached, survives an offline start
- [ ] Offline start shows cached models
- [ ] Unknown model → typed notice, picker still usable
- [ ] Missing WebView2 → explained before first paint
- [ ] libsecret-unavailable detected and reported
- [ ] `grep -ri 'api[_-]?key\s*='` finds nothing
- [ ] **Model picker lists every catalogue model with its limits**, and selecting one writes only
      `thread`-level state — the thread stays open, `tools_frozen` is untouched (`D19`)
- [ ] **Per-thread model switch is allowed mid-conversation**; switching on Sonnet 5.5 warns that
      prior thinking blocks are account-bound and will be dropped, but does not block the switch
- [ ] **Thinking-effort control** (`D76`) sets `effort` / `thinking.display` as request parameters
      only — changing it must **not** alter the system-prompt hash, and a test asserts that
- [ ] Effort change takes effect on the next turn and does not retro-edit stored blocks
