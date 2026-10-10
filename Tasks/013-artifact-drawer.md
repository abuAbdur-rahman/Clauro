# Task 013 — Artifact drawer

**Phase** 3 · **Depends** `001` verdict · **Decisions** D1, D2, D3, D45, D63, D77, D108
**Contracts** §1, §2

**Gated on `Task/001`.** If WebKitGTK does not hold an opaque origin, artifacts ship Windows-only and
Linux gets a runtime disable with a notice naming the reason (`D45`). Do not start this task before
that verdict exists — the CSP and sandbox flags would otherwise be designed twice.

**Status: backend + drawer states verified 2026-10-05 (Windows host).**
Tool 3/3 (`crates/clauro-tools/tests/artifact.rs`), drawer state/gate/sandbox
12/12 (`src/artifact.test.ts`, `src/ArtifactDrawer.test.tsx`), app boots without
crashing in a real browser (boot gate holds without Tauri). Webview-observable
criteria below are **NOT RUN ON THIS HOST** — no tauri-driver until 021; the
001 spike proved the *shape* on WebView2, the product frame is unverified.

## Failing tests first

- [x] The iframe's `contentWindow` has **no reachable command path** to `window.__TAURI_INTERNALS__` — **RUN 2026-10-10 (D124).** Literal absence is unachievable on Windows (wry injects init scripts into every frame); the proven property is inertness: remote-by-construction document host (`src-tauri/src/artifact_doc.rs:421` pins `http://artifact.localhost/__clauro/doc/`, `no_capability_grants_a_remote_context` pins zero remote grants) plus the engine proof — frame-side `invoke('webview_status')` never resolves while the shell's resolves (`scripts/webview-proofs.mjs` claim 1, 8/8 green, report at `target/webdriver/proofs-report.json`). The frame carries no Tauri API import by construction (no `api` import in the drawer tree).
- [x] `parent.document` access from inside the frame is refused — **RUN 2026-10-10**, same proof run (claim 2: `refused:SecurityError`)
- [x] `event.origin` from the frame is `"null"` — **RUN 2026-10-10**, same proof run (claim 3)
- [x] A `fetch` from inside the frame to any host **fails** — **RUN 2026-10-10**, same proof run (claim 4: `failed:TypeError`; CSP assembly is 014's)
- [x] A refused `MessageChannel` handshake leaves the frame inert, not broken — **RUN 2026-10-10**, same proof run (claim 5: `boots=0, alive="PROOF-OK", channel=ready`; channel is 014's)
- [x] On a Linux build where the gate fires: artifacts are absent **and** the notice explains why — `src/artifact.test.ts:66`, `src/ArtifactDrawer.test.tsx:44` (gate matrix + notice render; engine proof itself pending 021)

## Do

**We define the tool schema** (`D1`). The model returns structured JSON. **There is no fence to
detect and no first-party format to verify.** This deleted the single largest unknown in the project.

**The sandbox, precisely** (`D2`, transport `D123`, host `D124`):
```
served document  +  sandbox="allow-scripts"   and NOT allow-same-origin
http://artifact.localhost/__clauro/doc/<nonce>   (remote to Tauri's IPC)
```
> The document is a **transport** choice. `sandbox` is the **security boundary**. The
> served document would be same-origin with the shell on its own — the opaque origin comes
> from the attribute, and the IPC remoteness comes from the dedicated scheme. Adding
> `allow-same-origin` back silently breaks both **and** breaks the `event.origin` validation
> the same rule requires.
>
> History: `srcdoc` was the first transport and could never run a script (the shell's
> header CSP inherits into `about:srcdoc`, D123); the shell's own host was the second and
> read as local to Tauri's IPC (D124). Both supersedes are recorded, never renumbered.

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

- [x] No reachable command path to Tauri internals — **RUN 2026-10-10 (D124):** present-but-inert, engine proof 8/8 (`scripts/webview-proofs.mjs`, report at `target/webdriver/proofs-report.json`)
- [x] `parent.document` refused; `event.origin` is `"null"` — **RUN 2026-10-10**, same proof run
- [x] Outbound request from inside the frame fails — **RUN 2026-10-10**, same proof run (CSP: 014)
- [x] No user-facing control weakens sandbox tokens or CSP — flags are host-fixed (**D108**) — `src/artifact.test.ts:44-49` (`allow-scripts` exact, `allow-same-origin` throws); no settings UI for flags exists
- [x] Windows and Linux both render — or Linux disables with a notice — gate matrix + notice render (see above); engine proof pending 021
- [x] Artifact tool schema is ours, documented — `crates/clauro-tools/src/registry.rs` artifact block (`title`, `mediaType`, `source`, optional `artifactId`); strict validation in `crates/clauro-tools/src/artifact.rs` (the "classifier" the contract points at)
- [x] `DESIGN.md` §3 matches the shipped behaviour — §3 states the D45 guarantee; tabs/download promise corrected to v2-only per `SPEC.md` §5 (D87)

## Addendum 2026-10-09 — the production producer (D121)

The D113 precondition ("no production producer until a host drives turns") is met: the translator
(**D119**) and the mock witness (**D120**) drive real turns, so the last inch landed as production
code, in this order, each with its failing test first:

- **Store**: `latest_artifact` newest-row query (`crates/clauro-store/src/lib.rs`, `ArtifactRow` —
  newest `created_at` wins, tie by version, never crosses threads; empty thread is `None`, not an
  error) — `crates/clauro-store/tests/schema.rs::latest_artifact_is_the_newest_row_of_that_thread_and_none_when_empty`.
- **Command**: `artifact_latest` → `ArtifactLatest { artifactId, version, title, mediaType,
  source }`, source resolved from the session root and a missing file failing typed —
  `src-tauri/src/turn.rs::latest_artifact_document`, registered in `src-tauri/src/lib.rs`.
- **Producer**: `src/features/artifact/live.ts` — `block_start` on `artifact` flips the drawer to
  compiling with **no id** (the id does not exist yet); turn-done reads `artifact_latest` and lands
  content + `setLive`; no row clears the spinner instead of spinning forever; a failed read is a
  typed reason through the view's notice. Wired by `ChatView` (`useArtifactProducer`), whose test
  `"drives the artifact drawer from turn events (D121)"` is the §7a caller proof.
- **Drawer**: prepares when the artifact is *known*, not when the state says `compiling`
  (`src/components/ArtifactDrawer.tsx`); live-path test in `src/components/ArtifactDrawer.test.tsx`.
- **Shell**: drawer props come from the content store (`src/app/App.tsx`).
- `src/features/artifact/phase3.e2e.test.tsx` keeps its test-local driver as the composition proof
  under test — it now sits *beside* the production producer instead of standing in for it.

Still **NOT RUN in an engine**: the Linux verdict (001/WebKitGTK, D45) — the Windows
proofs above say nothing about the other floor.

## Addendum 2026-10-10 — the webview proofs ran (D123, D124), 8/8 green

The five webview-observable criteria are closed on Windows: `pnpm proofs` drives the real
build through the production pipeline (seeded row → producer → prepare → publish → frame)
and asserts the render plus claims 1–5 (`scripts/webview-proofs.mjs`, report at
`target/webdriver/proofs-report.json`). Two findings on the way, both fixed in the same
commit: D123 (served document replaces `srcdoc`, which could never run a script) and D124
(dedicated `artifact` scheme replaces the shell's host, which read as local to Tauri's IPC).

**Same date — the handshake loop closed (D122), a precondition of the proofs.** Criterion 5
("a refused `MessageChannel` handshake leaves the frame inert") needed a handshake that exists;
`hostSide` had no production caller and the frame never posted a window-level hello — two
unit-tested halves that never met. Closed in production: frame → `parent.postMessage`, host
listens on the shell's own window, `ArtifactDrawer` attaches per live document, readiness is
`data-artifact-channel`, error-level reports surface through the failed presentation. Webview
evidence lands with the tauri-driver run.
