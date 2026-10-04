# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a sandbox escape or a credential leak.**

Use GitHub's private reporting: **Security → Report a vulnerability** on
<https://github.com/abuAbdur-rahman/Clauro>.

If private reporting is unavailable to you, open a public issue that says
only *"security report, please open a private channel"* — with **no technical
detail** — and wait for a response.

Please include: what you built or ran, which platform and webview version, what
you expected, and what happened instead. A minimal reproduction is worth more
than a paragraph.

## What is in scope

This project exists because of its security guarantees. These are the claims a
report should target:

| Claim | Decision |
|---|---|
| The artifact frame is an **opaque origin** with no reachable path to app internals | **D2**, **D6** |
| **No network egress from an artifact** — `connect-src 'none'`, no CDN allowlist | **D3**, **D90** |
| A **denied tool is removed from the request**, not filtered from results, so it cannot be socially engineered | **D26** |
| Path handling cannot be walked out of, and Windows reserved device names are rejected | **D34**, **D79** |
| API keys live in the **OS keychain only** and never reach SQLite | `AGENTS.md` |
| **Nothing throws across the tool boundary**; a non-zero exit is `ok` with output attached | **D55** |
| `question` **refuses secret-shaped prompts** | **D43** |
| `bash` is **off by default**, per-project, per-invocation, persists nothing | **D28**, **D66**, **D67** |

Out of scope: the Claude API itself, the webview runtime's own sandbox, and
anything requiring an account you do not control.

## Known and accepted limits

Documented rather than hidden. Read [`MISSION.md`](MISSION.md) §5 and
[`DESIGN.md`](DESIGN.md) §3 for the user-facing versions.

- **WebRTC is not covered by `connect-src`.** There is no CSP directive for it,
  and `dns-prefetch` leaks the host name. This is why the network claim is
  stated as what CSP proves (**D90**).
- **`freezePrototype` is not artifact hardening.** It runs as a Tauri *webview*
  init script; a `srcdoc` iframe is not a webview (**D77**).
- **`frame-ancestors` is ignored in a `<meta>` CSP** and is therefore absent
  (**D93**).
- **`MessagePort` messages have an empty origin and a null source.** The
  handshake is validated once; after that the port itself is the capability
  (**D91**).
- **Path safety depends on canonicalising before checking.** A check-first
  implementation is bypassable by a symlink or a junction.

## Licence integrity is a security property here

The porting argument depends on it. A GPL or AGPL dependency would make this
MIT repository undeliverable, so licence drift **fails the CI build** rather
than appearing in a report nobody reads. Three MIT projects are permitted as
reference; one non-open-source project is observation-only and nothing may be
taken from it (**D59**, **D60**).

## Supply chain

- Dependencies are pinned. CI uses `--locked`.
- Every scan is currently `exit-code: 0` (**report**, do not block) and is
  reverted to blocking once its output has been read once. Trivy coverage is
  OS packages, language dependencies, secrets, misconfiguration and licence.
- `main` and `dev` are protected: pull request required, one approving review,
  linear history, no force push, no deletion, conversation resolution required.
- The Aqua Trivy action is used **by reference, never vendored or cloned**.