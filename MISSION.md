# Clauro — MISSION.md

> One page. If it does not survive here, it is not part of the product.

## What this is

**Clauro is a lightweight, local-first desktop client for people who already have an API key.**

It chats with models across providers, renders artifacts as live sandboxed pages, keeps per-project
memory, and gets out of the way. Summon it with a hotkey, drive it from the keyboard, export or
delete everything. It never phones home.

## The problem it solves

Getting good value out of a frontier model today means surrendering your conversations to someone
else's server. Every hosted chat client stores your threads, profiles you for ads, gates the useful
features behind a subscription, and gives you no way to see or delete what it kept.

Clauro assumes you already pay for tokens. It charges you nothing, asks for no account, and keeps
your threads in a SQLite file you own and can delete.

## Who it is for

People who:

- already hold one or more provider API keys and know what a token costs
- read code, or read people who write code — the audience is technical and unforgiving
- want their work to stay on their machine
- are tired of a subscription to use software they are already paying to run

## What it is not

- **Not a coding agent IDE.** No worktrees, no hooks, no subagents, no MCP. If a feature only makes
  sense inside a terminal workflow, it does not ship.
- **Not a hosted service.** No accounts, no sync, no teams, no sharing links.
- **Not a Claude client.** Anthropic is one provider among two adapters. The UI never branches on
  provider.
- **Not telemetry-compatible.** There is no telemetry. There will never be telemetry.

## The four claims we make, and what backs each

| Claim | Backed by |
|---|---|
| Your conversations never leave your machine except to your chosen provider | Direct provider calls. No proxy, no relay, no crash reporter. |
| We collect nothing | No telemetry code exists. Logs are local files. |
| Artifacts cannot touch your system | An opaque-origin iframe with no reachable path to app internals. Its network surface is closed by CSP for every fetch, subresource and frame load, and `connect-src 'none'` blocks `fetch`/XHR/WebSocket. **We do not claim it cannot touch the network at all** — see the caveat below. |
| You can see every command before it runs | `bash` is off by default and every invocation is individually approved. Nothing is remembered. |

**One honest caveat, stated in the product too:** with `bash` enabled, Clauro runs
model-authored commands on your machine under your account. Scrubbed of credentials, process-group
killed, confined to a session workspace — **but not sandboxed.** No container, no namespace, no
seccomp. We do not describe Clauro as sandboxed while you have it on.

## What "done" means for v1

A user can install Clauro, paste a key, chat, get an artifact rendered live, accumulate memory
within a project, run a command after approving it, and delete every byte they ever typed — without
the app having asked a server for anything.

Everything else is v2 or v3, and the plan says which.

## How we decide things

Every non-obvious choice is a numbered decision in `DECISIONS.md` with a reason attached. Every
decision that a test can assert against has a corresponding shape in `CONTRACTS.md`. New work
starts as a task in `Tasks/` that names both.

We take from three MIT-licensed projects — **OpenCode**, **DeepSeek Harness**, **LibreChat** — and
reimplement what we borrow. One project we read and took nothing from. See `FEATURES.md` for which
is which.

We do not claim to have invented the wheel. We claim to have picked it up correctly.

## The one thing that could kill this

The sandbox spike, `Tasks/001`. Whether WebKitGTK holds an opaque origin is not documented anywhere
and cannot be resolved by reading. If it does not, artifacts are disabled at runtime on Linux — one
package, told to the user plainly — and D2 is withheld on that engine rather than weakened
everywhere.

That is why it is the first task.
### The one claim we deliberately narrowed

We do not say **"artifacts have no network egress."** We say **an artifact cannot fetch, cannot
load a remote script, image, font or frame, cannot post a form, and cannot open a window.** Those
are CSP properties and they are testable.

The broader claim is false as stated, and knowing exactly why is the point:

- **WebRTC data channels bypass `connect-src`.** No browser ships a `webrtc` CSP directive, so
  there is no policy that closes them. A peer connection opened from an artifact is a channel out.
- **`dns-prefetch` can leak.** It is not gated by the directives we set.
- **Self-navigation** (`location = …`, meta refresh) may not be covered by the document's policy.
- **`window.open`** is governed by `sandbox`, not CSP — and we do allow scripts, so a popup is
  possible unless the token list forbids it.

`Tasks/001` and `Tasks/014` carry a probe for each of these on **both** engines before v1 ships.
Until they pass, the honest position is the narrow one above.
