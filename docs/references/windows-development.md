# Development and testing are Windows-only, for now

**Ref: `AGENTS.md` §8a.** Decided 2026-10-04; split into this file 2026-10-06. **Strengthened
2026-10-13 (D132):** this is no longer sequencing — Clauro v1 is Windows-only.

Every local build, test run, and manual verification happens on **Windows / WebView2**, which is now
the only platform we ship.

**What this means concretely:**

- The local toolchain is the Windows one: MSVC, `x86_64-pc-windows-msvc`, Windows-side node/npm.
  **No cross-compilation, and none is needed.**
- A probe, verdict, or measurement is **Windows-only until labelled otherwise**. There is no second
  engine to verify against any more, so a claim in this repo is a claim about WebView2 and must read
  that way.
- The Linux column is **withdrawn, not pending** (D132): `Tasks/001`'s WebKitGTK half is out of
  scope, so nothing is owed there.

**Why the Linux question was parked, and why it is now closed.** WebKitGTK development headers were
never installed on the development host and needed a sudo password an agent cannot supply, so Phase 0
took the WebView2 half — which `D89` had already made the verdict that gates a release. D114/D115
parked the Linux CI jobs, D126 restored them on 2026-10-12, and the first release run this repo ever
executed failed on its `aarch64-unknown-linux-gnu` leg while both Windows legs proceeded. **D132**
therefore removed the platform rather than deferring it a third time.

**This is a platform decision now, not a sequencing one.** Re-entering Linux is a new decision
(`D132` says so) and would need the proof `D45` always asked for — never a revert of this file.

## Related

- [`windows-shell.md`](windows-shell.md) (§8b) — the tooling available on this host.
- [`task-closeout.md`](task-closeout.md) (§7a) — how to label a criterion you could not verify here.