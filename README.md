# Clauro

A lightweight, local-first, BYOK desktop client for Claude.

Native desktop, single binary, no account, no telemetry. Your conversations stay on your machine
except for the calls you make to the provider you configured.

**This repository currently contains the specification, not the application.** 95 numbered decisions,
the contracts every test hangs off, and 23 contract-anchored tasks. There is no `src/` yet.

| | |
|---|---|
| Read first | [`AGENTS.md`](AGENTS.md) — the document set and the authority order |
| What it is | [`MISSION.md`](MISSION.md) |
| What must exist in v1 | [`SPEC.md`](SPEC.md) |
| Why each choice | [`DECISIONS.md`](DECISIONS.md) (D1–D95) |
| Testable shapes | [`CONTRACTS.md`](CONTRACTS.md) |
| How it fits together | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| What to build, in order | [`PHASES.md`](PHASES.md) · [`Tasks/`](Tasks/) |

## Status

`Tasks/001` — the dual-engine artifact sandbox spike — gates v1. Nothing is built on top of it yet,
deliberately.

## Licence

MIT. Ported designs are attributed in [`FEATURES.md`](FEATURES.md); three MIT projects were reference
implementations and one non-open-source project was read for observation only.
