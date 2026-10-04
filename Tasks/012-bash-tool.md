# Task 012 — `bash` tool

**Phase** 3 · **Depends** `010` (the workspace tree must be proven first)
**Decisions** D28, D29, D30, D46, D66, D67 · **Contracts** §3

**This tool changes the product's security claim** from *"never executes code on your machine"* to
something narrower. That is a deliberate decision, recorded in `MISSION.md` §5 and `DESIGN.md` §3, and
it is a **release decision** (`AGENTS.md` §8).

## Failing tests first

- `bash` is **absent from the request schema** unless the project opted in
- ~~Enabling `bash` **opens a fresh thread**; an already-open thread does not gain it~~ — **superseded on the Claude API by `D94`**. It is declared with `defer_loading: true` and handed over with `tool_addition`, so the open thread *does* gain it. This is still the behaviour on the OpenAI-compatible adapter.
- Every invocation requires approval; **no rule is ever persisted**
- A rejected command returns `status:'rejected'` — a result, not an error
- **A non-zero exit is `status:'ok'` with output attached** `D55`
- The credential scrub runs on the child environment
- Killing the process kills the **process group**
- The model-facing tool schema has **no `stdin` and no `env`** `D29`
- An ordinary `env` entry **cannot displace a managed value** `D30`

## Do

**Consent — three layers, none of them remembered** (`D28`, `D66`, `D67`):
1. off by default, per project
2. ~~opting in opens a fresh thread (tool list is frozen per thread, `D19`)~~ — **Anthropic path: the thread gains `bash` in place via `D94`.** Adapter path: still a fresh thread, because that adapter freezes the array. Either way the note tells the user which happened, so the failure mode
   is a silent no-op: the user opts in, asks for a command, nothing happens, no visible reason
3. **every single invocation is approved.** Dialog shows the exact command and working directory.
   Approve or reject. Nothing persists — no trust-on-first-use, no allowlist, no remembered prefix.

> *The interrupting cost IS the feature.* A persisted allowlist would let a prompt-injected model
> inherit approval and run unattended in the session workspace, with nothing in the UI saying so.
> **No yolo in v1.**

**One host-owned runner** (`D29`, PORTED from DeepSeek):
- process-group kill
- output truncation **with spill** to disk
- **credential scrub on the child environment**
- fd0 `/dev/null` when no stdin is supplied
- the **model-facing tool exposes neither `stdin` nor `env`** — shell syntax already covers both, and
  duplicate parameters would add surface without authority separation

**Env merge order is fixed** (`D30`):
```
scrub(process.env)  →  internal overrides  →  ordinary env  →  managed
```
Managed always wins. A model-supplied entry can never displace it.

**Not sandboxed.** No container, no namespace, no seccomp. Scrubbed, killed, confined — not
contained. Say so in the UI, not only in this file.

**Does not inherit the Linux webview gate** (`D46`). Artifact frame safety depends on the engine;
`bash` is a host-side capability, root-confined and opt-in regardless. Conflating them would disable
a useful feature on one platform for a risk that is not shared.

## Acceptance criteria

- [ ] Absent from schema unless opted in
- [ ] Opt-in is visible and truthful: on Anthropic the note says `bash` becomes available to this conversation; on the adapter it says a new thread is needed. **The UI must never claim a fresh thread is required when it is not**
- [ ] Every command individually approved; **zero persistence**
- [ ] Reject → `rejected` result
- [ ] Non-zero exit → `ok` with output
- [ ] Credential scrub verified
- [ ] Process-group kill verified
- [ ] No `stdin`/`env` on the model tool
- [ ] Managed env cannot be displaced
- [ ] Root-confined to the session workspace
- [ ] `MISSION.md` §5 and `DESIGN.md` §3 reflect the change

## Enabling `bash` no longer opens a fresh thread on Anthropic (`D94`)

`D67` said a project opting into `bash` had to start a fresh thread, because `tools` was frozen for a
thread's life. On the Claude API that is **superseded**: `bash` is declared on the first request with
`defer_loading: true` and handed over with a `tool_addition` block.

The spec change in one line: **the opt-in note no longer says "this opens a new thread" on Anthropic.**
It says the tool becomes available to this conversation shortly. On the OpenAI-compatible adapter the
old behaviour still applies and the note is still shown.

Failing tests first:

- [ ] Optting in on the Claude API makes `bash` callable in the **currently open** thread.
- [ ] Opting **out** removes it from the open thread via `tool_removal`.
- [ ] The `tools` array in the first request is byte-identical before and after the opt-in.
- [ ] On the OpenAI-compatible adapter, opting in does **not** affect an open thread, and the UI says so.
