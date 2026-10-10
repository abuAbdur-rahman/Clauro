# Task 014 — Artifact compile, CSP, and the message channel

**Phase** 3 · **Depends** `013` · **Decisions** D4, D5, D6, D12, D78, D102, **D110, D111**
**Contracts** §3

**Status: verified 2026-10-05 (Windows host), 70 frontend + 6 Rust tests green; engine
criteria RUN 2026-10-10, 8/8 proofs green (see addendum).** `src/artifact/` — 64 tests across `compile`, `channel`, `envelope`, `sanitize`,
`prepare` and `frame-runtime`, plus 6 in `ArtifactDrawer.test.tsx` and 6 in `src-tauri/src/csp.rs`.
Every criterion below that needs a real engine is marked **NOT RUN** and stays open until `021`;
the rest cite the test that discharges them. Two decisions were written before the code because
`D4` did not settle them: **D110** (JSX compiles to a host `h()`, no runtime shipped) and **D111**
(the vendored Tailwind CSS belongs to `022`, not here).

## Failing tests first

- [x] A JSX artifact compiles and runs — `src/artifact/frame-runtime.test.ts:172` (real Sucrase output, real DOM, a click handler that mutates the artifact's own state)
- [x] **A deliberately infinite loop in an artifact times out and does not freeze the UI** — `src/artifact/compile.test.ts:93` (a worker that never answers times out and is terminated). **Scope note:** this bounds a *wedged compile worker*. A loop in the artifact's own JS runs inside the frame, where it can freeze the frame's renderer and nothing else — the host's UI is a different process-boundary away, which is the property `A6` asks for. It is **not** a test that a frame cannot be frozen, and no such claim is made.
- [x] An artifact exceeding the compiled-size cap is refused with a clear error — `src/artifact/compile.test.ts:105`
- [x] SVG containing `<script>` is neutralised — `src/artifact/sanitize.test.ts:13` (plus `onload`, `foreignObject`, `javascript:` and external refs)
- [x] A message not on the allowlist is ignored — `src/artifact/channel.test.ts:104` (four spoofed names, three wrong shapes; nothing logged, nothing replied)
- [x] A message whose `event.source` is not the artifact frame is ignored — `src/artifact/channel.test.ts:118` (host side) and `src/artifact/frame-runtime.test.ts:219` (frame side)
- [x] A same-origin link click inside the frame does not navigate the host webview (**D102**) — `src/artifact/frame-runtime.test.ts:274`. Weaker than the criterion's wording, honestly: a fragment link is left to the frame and a `sandbox` without `allow-top-navigation` is the browser's half, neither of which jsdom can observe. What is asserted is the *decision* — fragment allowed, `_top` blocked — and that the guard is installed before any artifact code runs.
- [x] An external link target from inside the frame is blocked and logged (**D102**) — `src/artifact/frame-runtime.test.ts:262` (`defaultPrevented` plus an `artifact.nav_blocked` message carrying the target)
- [x] An artifact referencing `localStorage` renders blank **and the model was told it would** — `crates/clauro-loop/tests/prompt.rs:90` asserts the prompt names `localStorage`, `sessionStorage` and `indexedDB`. The rendering half is the browser's storage partition and is covered by the `001` probe, not here.

## Do

**Sucrase in a Worker** (`D4`), `transforms: ['jsx','typescript','imports'], production: true`.
**In-browser, not Rust/WASM** — the compile happens client-side because the artifact *runs*
client-side. ~1 MB, and it is the single largest known contributor to the binary budget beyond the
shell itself.

Worker + timeout + output size cap. One infinite loop in one artifact must not take down the host.

**DOMPurify on SVG**, shipped **only in the artifact frame**, never in the main bundle.

**MessageChannel handshake** (`D6`):
- parent creates the channel, transfers `port2` at load
- allowlist every message in both directions
- **validate `event.origin` AND `event.source` on every message**
- the opaque origin comes from the `sandbox` attribute, not from `srcdoc` (`D2`) —
  `about:srcdoc` inherits the parent origin on its own
- so also assert `event.source === iframe.contentWindow` and reject unexpected non-null origins

> Prefer `MessageChannel` over raw `postMessage`: the port reference never leaks to
> artifact-controlled code, and the channel auto-closes if the frame navigates away.

A real first-party client shipped a blank-artifact bug from exactly this class of origin mismatch.
That is why every one of these is a test, not a review comment.

**Only predefined Tailwind classes** (`D5`). No arbitrary values. This is precisely what makes a
no-build-step Tailwind possible inside an artifact — and the system prompt must say so, or the model
emits dead classes and the artifact looks broken.

**CSP assembled in Rust**, not in the web app, so the webview cannot weaken it. If Tauri ever needs
to be told to stop rewriting it, `dangerousDisableAssetCspModification` takes a **list of strings** —
disable only the named directives, never the boolean form (`D78`), which switches off nonce injection
**app-wide**.

## Acceptance criteria

- [x] JSX artifacts compile and run — `frame-runtime.test.ts:172`; the transform is real Sucrase with `transforms: ["typescript","jsx","imports"], jsxPragma: "h", production: true` (`src/artifact/compile.transform.ts:44`)
- [x] Infinite loop times out; UI survives — `compile.test.ts:93` (wedged worker → timeout + terminate). Scope caveat as above: this is the compile boundary, and the frame is the other side of the boundary from the host UI
- [x] Size cap enforced with a clear message — `compile.test.ts:105`; cap is 1 MB of *compiled* output (`COMPILED_MAX_BYTES`), reported as bytes-over-cap with the remedy in the message
- [x] SVG `<script>` neutralised — `sanitize.test.ts:13-58`, five cases. HTML is deliberately **not** sanitised and `sanitize.ts:9-16` says why
- [x] Allowlist enforced both directions — `channel.test.ts:63` (the lists) and `:104` (dropped, unreplied); host→frame `send()` throws rather than posting (`channel.ts:150`)
- [x] `event.source` validated on every message — `channel.test.ts:30-46` (origin *and* source), `frame-runtime.test.ts:219` (only `window.parent`). **Corrected against this task's own wording:** on the transferred port, per-message origin validation is not implementable by anyone — a port message carries an empty origin and a null source (SPEC `A5`, confirmed by the `001` spike). The allowlist is the gate there, and `channel.ts:12-20` says so
- [x] Same-origin in-frame clicks contained; external targets blocked and logged (**D102**) — `frame-runtime.test.ts:262-292`. Same honesty note as above about what jsdom can observe
- [x] CSP built in Rust; `connect-src 'none'` verified — `src-tauri/src/csp.rs`: `artifact_policy_names_every_d3_directive`, `the_artifact_policy_has_no_script_escape_hatches` (`script-src` is nonce-only, no `unsafe-eval`/`unsafe-inline`), `neither_policy_contains_a_wildcard_or_unsafe_eval`, and `tauri_conf_matches_the_assembled_app_policy` (the JSON cannot drift from the Rust copy). The front end holds **no** directive: `envelope.test.ts:60` reads the module's own source and fails on any `*-src` name in it. `dangerousDisableAssetCspModification` is never set (D78) — `csp.rs:1-20`
- [x] Tailwind-only constraint in the system prompt — `crates/clauro-loop/tests/prompt.rs:90` (asserts "predefined" alongside the storage names, `h(`, the `<script type="text/jsx">` shape and the 1 MB cap); wording in `crates/clauro-loop/src/prompt.rs:37`. Snapshot pin moved deliberately with a D39 re-read (`tests/prompt.rs:139`)
- [x] Binary size re-measured against the `002` baseline — `docs/build-baseline.md`, **2026-10-05**. Binary unchanged at **8.08 MB**; the frontend grew **+15.4 kB** (325.35 → 340.76 kB main chunk) with Sucrase (202.65 kB) and DOMPurify (28.08 kB) in chunks that load only when a JSX or an SVG artifact is prepared

## Not verified here, and why

- **Engine observation, closed 2026-10-10 (D123, D124):** `connect-src 'none'` failing a
  real fetch, the real `event.origin`/`event.source` handshake, and the render are now observed
  *in* the engine (`pnpm proofs`, 8/8 green) — superseding the caveat below for everything but
  Tailwind-in-the-frame (022) and the Linux floor (021/D45). The `001` spike's shape still
  stands; the product frame is now observed on Windows.
- **The real Worker thread.** jsdom has no `Worker`, so the tests drive the same message contract with an injected factory that runs the same `transformJsx`. The `Worker` construction in `prepare.ts:29` is therefore untested code — it is three lines and it is the only untested line in the pipeline, but it is untested.
- **No Tailwind in the frame.** `D111`: the stylesheet slot is wired and deliberately empty. Artifacts render unstyled until `022` vendors the build. The prompt tells the model to use predefined utility classes, so this is a visible gap, not a silent one.
- ~~**Nothing calls the drawer yet.**~~ **Closed 2026-10-09 (D121):** the production producer
  lives in `src/features/artifact/live.ts`, called by `ChatView` — turn events flip the drawer,
  turn-done fetches `artifact_latest`. (Was: no tool-result handler existed and `src/` was the
  Phase-0 shell; the check that proved it then was
  `Select-String -Path src\*.ts* -Pattern "setCompiling|setLive"`.)

## Addendum 2026-10-10 — the engine half of 014's criteria ran (D123, D124)

The "no webview" caveat above is closed on Windows for everything except Tailwind-in-the-frame
(022) and the Linux floor (021/D45): `pnpm proofs` (8/8 green, report at
`target/webdriver/proofs-report.json`) observes the assembled `connect-src 'none'` failing a
real fetch, the real `event.origin`/`event.source` handshake completing, and the compiled
pipeline rendering seeded bytes — through the production producer (D121), envelope, publish
seam and served document, with no test hooks. Two transport findings landed in the same
commit and are recorded as decisions, not asides: D123 (the document is served with a header
policy — `srcdoc` inherits the shell's header CSP and can never run a script) and D124 (the
document host is a dedicated `artifact` scheme, remote to Tauri's IPC — the shell's own host
read as local, and the frame owns an injected `__TAURI_INTERNALS__` on Windows).

## Addendum 2026-10-09 — the handshake's production wiring (D122)

**Finding:** `hostSide` and the frame's boot responder were two halves that never met in the
product — the host listened on the *frame's* window (cross-origin, unreachable by design) and the
frame never posted a window-level hello. Both were unit-tested; neither was reachable. The
webview proof of "a refused handshake leaves the frame inert" could not have observed a real
handshake, so the loop closed first, in the direction the sandbox permits (D122):

- **Frame half:** `frame-runtime.js` posts `artifact.hello` to `window.parent` on start —
  `frame-runtime.test.ts` "says hello to its parent on start" pins the direction by spying on the
  parent's `postMessage`.
- **Host half:** `channel.ts::hostSide` attaches to the shell's own window —
  `channel.test.ts` "the listener rides the shell's window, never the frame's (D122)" dispatches
  the hello on the shell with `source === frameWindow` and observes the boot *inside* the frame.
- **Caller:** `ArtifactDrawer.tsx` attaches per live document and disposes with it;
  `onReady` → `data-artifact-channel="ready"`; error-level reports → the failed presentation
  (test: `ArtifactDrawer.test.tsx` "attaches the channel host half to the live frame (D6, D122)").
