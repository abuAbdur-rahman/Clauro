# Task 001 — Dual-engine sandbox spike: VERDICT

**Status: WINDOWS VERDICT RECORDED 2026-10-04. Linux column not run on this host.**

This file is the deliverable of `Tasks/001`. Every Windows cell below is an observed value from a
run of the throwaway probe app (`spikes/sandbox-probe`, gitignored) against the real WebView2
runtime — not a prediction. The Linux column reads "not run" throughout, per `AGENTS.md` §8a.

---

## Environment under test

| | Windows half | Linux half |
|---|---|---|
| Engine | **WebView2** | WebKitGTK |
| Runtime version | **153.0.4234.48** — verified from `HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-…}\pv` **and** `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\`. The frame's own UA confirms it: `Chrome/153.0.0.0 … Edg/153.0.0.0`. | not resolved |
| Host OS / toolchain | Windows, MSVC `x86_64-pc-windows-msvc`, Rust 1.96.0 | — |
| **Tauri pinned** | **`=2.12.1`** (`tauri-build =2.7.1`) — pinned **exactly**, not `^2`, because the IPC-injection rule is version-dependent (**D92**) | same crate, not built |
| Frontend | TS **6.0.3**, Vite **8.3.2**, React **19.3.0** (resolved from `pnpm-lock.yaml`, matching the Tauri template) | same |
| Probe binary | `spikessandbox-probe.exe`, 4.05 MB release build | — |
| Status | **run, full results below** | **not run on this host** |

**Why the Linux column is empty (`AGENTS.md` §8a).** WebKitGTK development headers are not installed
on this host and require a sudo password an agent cannot supply non-interactively. Per `D89` the
**WebView2 verdict is the one that gates a release** and the WebKitGTK verdict is best-effort — so
the empty column does not block Phase 0. It stays empty until genuinely run; it is never filled in
by inference.

---

## Probe results — Windows WebView2

Verdicts: **PASS** = the security property held. **FAIL** = it did not. Two of the FAILs below are
the documented `D90` holes, not surprises — see the bypass section.

### The policy probes (`D2`, `D3`, `D83`)

| probe | observed | expected | verdict |
|---|---|---|---|
| `parent.document` | `refused: Failed to read a named property 'document' from 'Window': Blocked a frame with origin "null" from accessing a cross-origin frame.` | refused | **PASS** |
| `localStorage.setItem` | `threw: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.` | throws | **PASS** |
| `fetch` (`connect-src 'none'`) | `rejected: Failed to fetch` | blocked | **PASS** |
| `<script src="https://…">` (`default-src 'none'`) | `blocked (onerror)` — the element fired error, never load | blocked | **PASS** |
| `<iframe src="https://…">` (`frame-src 'none'`) | `blocked - error document, contentDocument null` — a `load` event fired but the nested frame holds an error document, not a remote one (a bare `onload` is not proof of fetch) | blocked | **PASS** |
| form POST (`form-action 'none'`) | `submit()` returned without throwing, **document SURVIVED** — verified by canary, not by absence of a throw | blocked (no navigation) | **PASS** |

Note the `parent.document` refusal names the frame's origin as **`"null"`** — the opaque origin is
observed, not assumed.

### The four bypasses — CSP does **not** close these (`D90`)

| probe | observed | verdict |
|---|---|---|
| **`RTCPeerConnection`** | `CONNECTION OPENED (RTCPeerConnection constructed)` — a peer connection with a STUN server could be constructed. Opening is the finding; sending data was not attempted. | **FAIL — the documented hole.** No browser ships a `webrtc` directive. Fix would be a sandbox token, never a quieter claim. |
| **`<link rel="dns-prefetch">`** | `link inserted (hostname may resolve)` — the element was accepted; resolution was not confirmed packet-level. | **FAIL — the documented hole.** Not gated by any directive we set. |
| **`location = "https://…"`** | **Frame NAVIGATED AWAY to a remote origin.** Run last, in a sacrificial frame, after every other probe reported — because this probe succeeds by destroying its own document (see §Harness learnings). | **FAIL — the documented hole.** The document policy did not hold for top-level self-navigation. Fix would be a sandbox token, never a quieter claim. |
| **`window.open("https://…")`** | `blocked (returned null)` | **PASS** — governed by `sandbox`, not CSP, and we grant no `allow-popups`. |

### The handshake (`D6`, `D91`)

| probe | observed |
|---|---|
| `postMessage` parent → child | Works — the handshake transfer itself is a `postMessage`, and the child acted on it. (The harness's `postMessageEcho: "failed"` initial state is a label artifact: the host never sends the `"ping"` the echo handler listens for. It is **not** a finding.) |
| **`event.origin`** (child's view) | Not directly captured on this run (`eventSourceIsContentWindow: null` — same harness gap). **Indirectly confirmed:** the `parent.document` refusal names the frame origin `"null"`, and the child→parent `ready`/`probe`/`echo` messages arrived. The explicit origin-capture row should be re-run in `014`'s harness with a real `ping`. |
| `event.source === contentWindow` | Same gap as above — re-run in `014`. |
| **`MessageChannel` transfer** | **Works.** `port2` transferred at handshake; child's `child-port-ready` arrived on `port1`; `ping-over-port`/`pong-over-port` round-tripped. |
| `event.origin` on a **port** message | `""` (empty string) — exactly as `D91` predicts: port messages carry no origin. |
| `event.source` on a **port** message | `null` — exactly as `D91` predicts. |

**D91 is confirmed in its load-bearing half:** the handshake transfers, the port is then the
capability, and port messages carry no origin/source to validate (which is why `D91` validates once,
at the handshake). The explicit `event.origin === "null"` capture is the one cell to re-prove in
`014` — recorded here as a gap, not as a pass.

### The IPC probes — asserted on **effect** (`D92`)

The frame attempted four calls against a host command whose only effect is writing
`privileged-probe-sentinel.txt` next to the executable. Each attempt raced a 3000 ms timeout so a
hung promise is recorded as "no response" rather than stalling the run.

| call from inside the frame | observed | effect |
|---|---|---|
| `window.__TAURI_INTERNALS__.invoke("privileged_probe")` | **no response (timed out after 3000 ms)**, threw `null` | none |
| `window.__TAURI_INTERNALS__.postMessage({cmd:"privileged_probe"})` | `returned undefined (no effect)` | none |
| `window.ipc.postMessage("privileged_probe")` | `returned undefined (no effect)` | none |
| `window.chrome.webview.postMessage("privileged_probe")` | `returned undefined (no effect)` | none |
| **`privileged-probe-sentinel.txt` exists afterwards** | **`false`** (checked in-app via `sentinel_exists` **and** from the shell after exit) | — |

**Reading this precisely.** The `__TAURI_INTERNALS__` global **exists** in the frame (attempt 1 did
not throw "undefined" — it hung). But invoking through it produces **no response and no effect**:
the sentinel file does not exist. Absence of a global would have been the weaker fact; what was
observed is stronger — the reachable-looking path does nothing.

**Positive control.** `cargo test --release` proves `privileged_probe` genuinely writes the sentinel
when called (`privileged_probe_actually_writes_the_sentinel`, passing). A "does not exist" result is
therefore meaningful rather than a test that cannot fail (`AGENTS.md` §6).

---

## Verdict

**Holds on Windows.** The opaque origin holds on WebView2 153.0.4234.48 under Tauri 2.12.1: no
parent access, no storage, no fetch, no remote script/frame, no form navigation, no popup, no IPC
effect, working `MessageChannel` handshake with the `D91`-predicted empty-origin/null-source port
semantics.

The three `D90` FAILs (WebRTC construction, dns-prefetch insertion, self-navigation escape) are the
documented holes `MISSION.md` and `D3` already narrow the claim around — they were probed to confirm
the narrowing is honest, not to re-open it. If any of them must be closed, the fix is a sandbox token
(`D90`), and that decision belongs to `014` with its own measurement.

**Linux: not run.** The WebKitGTK column — including the sixth probe's actual question, whether
`MessageChannel` transfer survives WebKit's stricter `sandbox`+`srcdoc` behaviour — is empty until
genuinely executed. Per `D89` this does not gate the release; per `D45`, if it ever fails, artifacts
are disabled at runtime on Linux and the user is told in the product.

---

## Harness learnings (for `014`)

Three bugs in the spike harness itself, each caught by a guard that now exists. `014` inherits all
three guards:

1. **A destructive probe must run last, in a sacrificial frame.** Self-navigation succeeded in the
   main frame, destroying it mid-run; the IPC attempts never executed and "no sentinel" was a 0/0
   that read as a pass. Ordering is part of an effect-based assertion's correctness.
2. **The probe script is runtime browser JS — `tsc` cannot see inside the string.** A TypeScript `as`
   cast in the probe source passed the build and killed the whole probe document at parse time in the
   browser: zero probes, zero beacons. `spikes/sandbox-probe/check-probe.cjs` syntax-checks the
   extracted probe with `node --check` and rejects backticks/`${}` in the probe body.
3. **The bundler constant-folds `"<" + "/script>"` back into a literal.** Twice-bitten: the string
   form of the script close tag must be runtime-constructed (`String.fromCharCode(60,47)+"script>"`),
   and `check-probe.cjs` asserts it. (For an external bundle this particular truncation does not
   apply — HTML parsing only ends inline scripts — but the guard is cheaper than the analysis.)
4. **A liveness beacon distinguishes "blocked" from "never ran".** The probe posts `probe-alive` on
   boot; the host displays `THE RUN IS INVALID` until it arrives. This caught bug 2 instead of
   recording a false pass.
5. **A hung promise is a finding, not a stall.** `invoke` neither resolved nor rejected, which froze
   the first harness version with IPC "pending" forever. Every IPC attempt now races a 3000 ms
   timeout and records "no response".

---

## Reproducing

```powershell
cd spikes/sandbox-probe
npm install
npx tauri build --no-bundle
.\src-tauri\target\release\spikessandbox-probe.exe
# sentinel check after exit:
Test-Path .\src-tauri\target\release\privileged-probe-sentinel.txt  # MUST be False
```

**`spikes/` is gitignored.** This app is scaffolding to be deleted per `Tasks/001` acceptance — the
verdict is the deliverable, not the app.