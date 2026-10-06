# Development and testing are Windows-only, for now

**Ref: `AGENTS.md` §8a.** Decided 2026-10-04; split into this file 2026-10-06.

Every local build, test run, and manual verification happens on **Windows / WebView2**. Linux is a
shipped target (`D88`) but it is **not** a development environment yet.

**What this means concretely:**

- The local toolchain is the Windows one: MSVC, `x86_64-pc-windows-msvc`, Windows-side node/npm.
  **No cross-compilation, and none is needed.**
- A probe, verdict, or measurement is **Windows-only until labelled otherwise**. Do not write
  "verified" next to a WebKitGTK claim on the strength of a Windows run — that is the exact
  substitution that makes a sandbox claim a lie.
- When a task's verdict table has a Linux column, it reads **"not run on this host"** until someone
  has actually run it on Linux. `Tasks/001` is the live example.
- The Linux half is executed by **CI on GitHub's runners**, never by an agent on a developer machine
  (`TECH_STACK.md` §8).

**Why now, and what "later" means.** WebKitGTK development headers are not installed on the
development host, and they need a sudo password an agent cannot supply non-interactively. Rather than
block Phase 0 on an environment setup, we take the WebView2 half now — `D89` already makes the
**WebView2 verdict the one that gates a release** and the WebKitGTK verdict best-effort.

**This is a sequencing decision, not a platform decision.** Linux remains a first-class shipped
platform and its CI floor remains a **release blocker** (`D50`, `Tasks/021`). Nothing here licenses
treating WebKitGTK as unverified-and-therefore-fine: when the headers are installed, the Linux
column gets filled in properly, and until then it stays empty.

## Related

- [`windows-shell.md`](windows-shell.md) (§8b) — the tooling available on this host.
- [`task-closeout.md`](task-closeout.md) (§7a) — how to label a criterion you could not verify here.