# Task 001 — Dual-engine sandbox spike

**Phase** 0 · **Blocks** `013`, `014` · **Produces** a written verdict, not code

**Both halves are runnable on this host.** Windows is the primary platform (**D88**): the WebView2 half runs against the installed WebView2 runtime 153.0.4234.48, compiled and linked by the Windows-side MSVC toolchain. **The WebView2 verdict is the one that gates a release; the WebKitGTK verdict is best-effort** (**D89**).
**Decisions** D2, D6, D45, D77, **D88, D89** · **Contracts** none (deliberately — this task has no failing test because it writes no code; it produces a written verdict)

**Status: Windows half VERIFIED 2026-10-04. This task is NOT complete — the WebKitGTK half was never
run.** Verdict committed at `docs/spikes/sandbox-verdict.md`; Windows cells are observed values from
the probe app, not predictions. The Linux column reads "not run" throughout, per `AGENTS.md` §8a,
and stays empty until someone genuinely runs it — it is never filled in by inference.

Only **one** probe app was ever written (`spikes/sandbox-probe`, WebView2). The WebKitGTK app was
never created, which is why the column is empty. Three findings need a follow-up run under `014`:
`event.origin` and `event.source === contentWindow` were never captured even on Windows
(`spikes/sandbox-probe/src/App.tsx:352,442,453` hardcodes `null`), and the `fetch` row was probed
cross-origin rather than same-origin as this table specifies. Both are harness gaps, not engine
findings.

## Why first

No document anywhere states whether WebKitGTK holds an opaque origin. It cannot be researched —
only run. If the answer is no, artifacts are disabled at runtime on Linux (`D45`) and the drawer's
CSP and sandbox flags would otherwise need designing twice.

## Deliverable

Two throwaway Tauri apps, one minimal per engine. Not production code — scaffolding to be deleted.

Each renders a `srcdoc` iframe with `sandbox="allow-scripts"` and **no** `allow-same-origin`, then
attempts, in order:

1. `parent.document` — expect refusal (this is what `allow-same-origin` would enable)
2. `window.__TAURI_INTERNALS__` — expect `undefined`
3. `localStorage.setItem` — expect a throw (artifacts are told it is unavailable; confirm it is)
4. `fetch('https://example.com')` — expect a CSP failure
5. `postMessage` from parent → child, child echoes back — record whether `event.origin` is `"null"`
6. **`MessageChannel`** handshake: parent creates the channel, transfers `port2` at load, child echoes
   over the port — **record whether this works on WebKitGTK**

## The sixth probe is the point

WebKit's long-standing `sandbox`+`srcdoc` deviation (**Bugzilla 218086**, P2, open since 2020) errs
in the **stricter** direction — Safari blocks parent-registered event listeners that Chromium allows,
against spec. So the risk is not permissiveness; it is that `MessageChannel` transfer or listener
registration may be blocked outright. **Test that, not whether the sandbox is loose.**

## Verdict format

Write `docs/spikes/sandbox-verdict.md`:

```
| probe | Windows WebView2 | Linux WebKitGTK |
|---|---|---|
| parent.document | refused | refused |
| `window.__TAURI_INTERNALS__` | undefined | undefined |
| localStorage | throws | throws |
| fetch (same-origin, `connect-src 'none'`) | blocked | blocked |
| `<script src="https://…">` (`default-src 'none'`) | blocked | blocked |
| `<iframe src="https://…">` (`frame-src 'none'`) | blocked | blocked |
| form POST (`form-action 'none'`) | blocked | blocked |
| **`RTCPeerConnection`** | ? | ? |
| **`<link rel="dns-prefetch">`** | ? | ? |
| **`location = "https://…"`** | ? | ? |
| **`window.open("https://…")`** | ? | ? |
| handshake: `event.source === contentWindow` | ? | ? |
| handshake: `event.origin` | `"null"` | ? |
| MessageChannel transfer | works | ? |

Then one paragraph: **holds on both**, **holds on Windows only**, or **holds on neither**.

### The four bypass probes are not optional (`D90`)

CSP does **not** close every path off this list, and the first four rows prove a policy while the
bolded ones look for the holes in it:

- **WebRTC.** No browser ships a `webrtc` CSP directive, so `connect-src 'none'` cannot stop a peer
  connection. Record whether a connection can be *opened*, not whether it can send data — opening is
  the finding.
- **`dns-prefetch`.** Not gated by the directives we set. Record whether a hostname resolves.
- **Self-navigation.** `location = "https://…"` and a meta refresh may escape the document policy.
  Record whether the frame actually navigates away.
- **`window.open`.** Governed by `sandbox`, not CSP, and we do allow scripts. Record whether a popup
  opens.

If any of these succeeds, the fix is a **sandbox token** (`allow-popups`, or dropping
`allow-top-navigation`), never a quieter claim. `MISSION.md` states only what CSP proves.

### Probe 2 is being rewritten — `__TAURI_INTERNALS__ === undefined` is not a test (`D92`)

The old probe asserted a global was absent. **CVE-2024-35222** was not that: iframes could *reach*
Tauri IPC, and the fix stopped injecting the IPC script into iframes **except on Windows when origins
match**. A global being undefined proves nothing about that.

Assert on **effect**, not on absence. From inside the frame, actually attempt:

| call | expect |
|---|---|
| `window.__TAURI_INTERNALS__.invoke("privileged_probe")` | rejects or undefined — no execution |
| `window.__TAURI_INTERNALS__.postMessage({cmd:"privileged_probe"})` | no execution |
| `window.ipc.postMessage("privileged_probe")` | no execution |
| `window.chrome.webview.postMessage("privileged_probe")` | no execution |

The host registers a `privileged_probe` command that **writes a sentinel file**. After all four
attempts the file must not exist. Absence of a global is a weaker fact than absence of an effect, and
the effect is what the CVE was about.

**Tauri must be pinned at or above the version carrying the CVE-2024-35222 fix.** Record the exact
pinned version in the verdict file.

## Acceptance criteria

- [ ] Both apps build and run on their target engines — **PARTIAL.** WebView2 app built and ran
      (`docs/spikes/sandbox-verdict.md:20`); **no WebKitGTK app was ever created**
- [ ] Every probe in the table above runs on both engines, results recorded verbatim — **PARTIAL.**
      Windows recorded verbatim (`sandbox-verdict.md:38-45,52-57,81-86`); `event.origin` and
      `event.source` never captured (`sandbox-verdict.md:64-65,72-73`); Linux column empty
- [x] The `privileged_probe` sentinel file does **not** exist after all four IPC attempts —
      `sandbox-verdict.md:87` (`false`, checked in-app and from the shell after exit); positive
      control at `spikes/sandbox-probe/src-tauri/src/lib.rs:71`. Caveat: harness is gitignored, so
      this is not re-runnable from a clean clone
- [x] The exact pinned Tauri version (≥ the CVE-2024-35222 fix) is recorded — `=2.12.1` pinned
      exactly, not `^2` (`sandbox-verdict.md:18`; `src-tauri/Cargo.toml:18,22`). Minor gap: the
      verdict does not state *which* version carries the CVE fix, so "≥ the fix" is asserted
- [x] Verdict file committed — `docs/spikes/sandbox-verdict.md`, tracked since `adc581b`
- [ ] If "Windows only": `D45` implementation is already designed — confirm the notice copy —
      **PARTIAL.** Behaviour is designed (`DECISIONS.md:393-396`, `DESIGN.md:131`, `SPEC.md:30-31`)
      but **the notice copy does not exist** — the only `notice` strings in `src/` are
      model-catalogue notices (`src/ModelPicker.tsx:58,75-81`). Also the conditional is not yet
      triggered: Linux was never disproved, only never run
- [x] The throwaway apps are deleted, or clearly marked and excluded from the workspace —
      `.gitignore:22` and excluded from `Cargo.toml:3-12` members, proven by `cargo test --workspace`
      passing without touching it. Caveat: marked only in root `.gitignore`;
      `spikes/sandbox-probe/README.md:1` is still untouched Tauri boilerplate

## What this task does NOT do

It does not build the drawer, does not write the CSP, and does not design the runtime gate. It
answers one question. Anything more is scope creep on a two-day task.
