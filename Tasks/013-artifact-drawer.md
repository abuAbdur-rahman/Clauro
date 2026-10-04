# Task 013 — Artifact drawer

**Phase** 3 · **Depends** `001` verdict · **Decisions** D1, D2, D3, D45, D63, D77
**Contracts** §1, §2

**Gated on `Task/001`.** If WebKitGTK does not hold an opaque origin, artifacts ship Windows-only and
Linux gets a runtime disable with a notice naming the reason (`D45`). Do not start this task before
that verdict exists — the CSP and sandbox flags would otherwise be designed twice.

## Failing tests first

- The iframe's `contentWindow` has **no reachable path** to `window.__TAURI_INTERNALS__`
- `parent.document` access from inside the frame is refused
- `event.origin` from the frame is `"null"`
- A `fetch` from inside the frame to any host **fails**
- A refused `MessageChannel` handshake leaves the frame inert, not broken
- On a Linux build where the gate fires: artifacts are absent **and** the notice explains why

## Do

**We define the tool schema** (`D1`). The model returns structured JSON. **There is no fence to
detect and no first-party format to verify.** This deleted the single largest unknown in the project.

**The sandbox, precisely** (`D2`):
```
srcdoc  +  sandbox="allow-scripts"   and NOT allow-same-origin
```

> `srcdoc` is a **transport** choice. `sandbox` is the **security boundary**. `about:srcdoc`
> inherits the parent origin on its own — the opaque origin comes from the attribute. Adding
> `allow-same-origin` back silently breaks this **and** breaks the `event.origin` validation the same
> rule requires.

**No network egress** (`D3`): `connect-src 'none'`, `img-src data: blob:`, `form-action 'none'`. The
first-party product allowlists five public CDNs; we vendor what we need and render fully offline.
This is a privacy claim they cannot make. **Do not add a CDN allowlist.**

**`freezePrototype` does not help here** (`D77`). It runs as an init script on every Tauri *webview*;
a `srcdoc` iframe is not a webview. Do not count it toward hardening.

**The drawer is a layout column, not an overlay** (`DESIGN.md` §1) — a real slot means no z-index
argument and no CSP compromise for a floating window. Three states: empty (zero width), compiling
(*say "compiling"* — silence reads as a hang), live.

**One live artifact per `(thread, artifact_id)`, with a `version` column that increments on
refresh.** In-place refresh needs a stable target to refresh *into*, so the row in `CONTRACTS.md` §1
is keyed `(thread_id, id, version)` and the drawer always shows the highest version for that
`artifact_id`. In v1 there is no user-facing history, no pinning, no Preview/Code tabs and no
download — those are v2 (`ROADMAP.md`), because the render has to be trustworthy before we let a
user pin history. **Note:** this is *not* `D63`; `D63` is the compaction generation counter and has
nothing to do with artifacts.

## Acceptance criteria

- [ ] No reachable path to Tauri internals
- [ ] `parent.document` refused; `event.origin` is `"null"`
- [ ] Outbound request from inside the frame fails
- [ ] Windows and Linux both render — or Linux disables with a notice
- [ ] Artifact tool schema is ours, documented
- [ ] `DESIGN.md` §3 matches the shipped behaviour
