# Task 014 — Artifact compile, CSP, and the message channel

**Phase** 3 · **Depends** `013` · **Decisions** D4, D5, D6, D12, D78, D102
**Contracts** §3

## Failing tests first

- A JSX artifact compiles and runs
- **A deliberately infinite loop in an artifact times out and does not freeze the UI**
- An artifact exceeding the compiled-size cap is refused with a clear error
- SVG containing `<script>` is neutralised
- A message not on the allowlist is ignored
- A message whose `event.source` is not the artifact frame is ignored
- A same-origin link click inside the frame does not navigate the host webview (**D102**)
- An external link target from inside the frame is blocked and logged (**D102**)
- An artifact referencing `localStorage` renders blank **and the model was told it would**

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

- [ ] JSX artifacts compile and run
- [ ] Infinite loop times out; UI survives
- [ ] Size cap enforced with a clear message
- [ ] SVG `<script>` neutralised
- [ ] Allowlist enforced both directions
- [ ] `event.source` validated on every message
- [ ] Same-origin in-frame clicks contained; external targets blocked and logged (**D102**)
- [ ] CSP built in Rust; `connect-src 'none'` verified
- [ ] Tailwind-only constraint in the system prompt
- [ ] Binary size re-measured against the `002` baseline
