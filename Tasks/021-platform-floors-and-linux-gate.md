# Task 021 — Platform floors and the Linux artifact gate

**Phase** 6 · **Depends** `001`, `013`, `014` · **Decisions** D45, D46, D50, D77, D79, **D88, D89**
**Contracts** none (CI + runtime gate)

**This task is what makes "Windows and Linux" a claim rather than a hope.**

**Windows is the primary platform and its floor is the release blocker. The Linux floor and the WebKitGTK artifact gate are secondary** (**D89**): a Linux failure must not block a Windows release, but a Windows failure must block every release. Windows CI builds through the Windows-side MSVC toolchain with output on `/mnt/d` (**D88**).

## Failing test first

- CI **fails** on the Windows floor when WebView2 is older than the floor — build the gate, then
  verify it by pinning an old runtime
- The Linux artifact gate **fires** when WebKitGTK does not hold an opaque origin, and the notice
  appears
- The gate **does not** fire on a compliant build
- `bash` remains available on Linux **even when the artifact gate fires** `D46`

## Do

**Four-job matrix** (`D50`, `PLAN.md`):

| Job | Purpose |
|---|---|
| `ubuntu-latest` | Linux primary |
| `ubuntu-24.04` | **Linux floor** — older WebKitGTK. *(Was `ubuntu-22.04`, unsupported 2027-04-17.)* |
| `windows-latest` | Windows primary |
| `windows-latest` + **fixed-version WebView2 runtime** installed | **Windows floor.** *(Was `windows-2019`, not a current runner label — and an older OS image does not give you an older WebView2 anyway.)* |

**A floor failing is a release blocker, not a warning.** The Linux floor exists because `D45` depends
on WebKitGTK sandbox behaviour being *consistent across the supported range* — so the floor is a
testable envelope, and "Linux" without a named floor is not a claim.

**Cargo ships `WebKit2GTK` sys crates, but a distro-native build differs again.** **The CI matrix is
the real contract** — not the crate version, not the manifest.

**The runtime gate** (`D45`). Read the `Task/001` verdict and encode it. If WebKitGTK will not hold
an opaque origin: artifacts are **disabled at runtime on Linux**, with an in-app notice naming the
reason. One package; the user is told the truth.

> `D2` is **never weakened** — only withheld, on the one engine where we cannot prove it holds. A
> feature that works on one platform and is unsafe on the other is a worse product than a feature
> that is honestly absent.

**`bash` does not inherit the gate** (`D46`). It is a host-side capability, root-confined and
opt-in regardless of engine. Conflating the two would disable a useful feature on one platform for a
risk that is not shared.

**Windows floor checks** (`D79`): `MAX_PATH` is **opt-out** — removable since Win10 1607 via
registry or Group Policy, bypassable with `\\?\`. So **260 is a conservative target, not a hard
limit**, and we budget for it rather than depending on it. Reserved device names are the real
constraint, and `NUL.txt` is `NUL`.

## Acceptance criteria

- [ ] Four jobs, both floors genuinely enforced
- [ ] Floor failure blocks the release
- [ ] Linux gate fires on a non-compliant engine, with a notice
- [ ] Gate silent on a compliant engine
- [ ] `bash` still available on Linux with the gate firing
- [ ] Path checks pass on both floors
- [ ] `D2` present and unweakened in the shipped config
