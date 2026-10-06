# Windows shell tooling

**Ref: `AGENTS.md` §8b.** Split out of `AGENTS.md` on 2026-10-06.

Per [`windows-development.md`](windows-development.md) (§8a) this is a Windows-only development
environment. Applies on this host, and only where the tool is actually installed — verify with
`Get-Command <tool>` before relying on it.

**Installed:** GNU coreutils (uutils) at `C:\Program Files\coreutils\bin`, plus `rg`, `bat`,
`lsd`, `fzf`, `zoxide`, `btop`, `curl`, `uv`, `sqlite3`, `gh`, `xxd`, `git`.
**Not installed:** `jq`, `fd`, `delta`, `dust`, `eza`, `sd`, `lazygit`, `sed`, `awk` — the last
two exist only under `C:\Program Files\Git\usr\bin`, which is not on PATH. Anything outside
these two lists is unverified; check before use, don't assume.

**The trap.** PowerShell aliases shadow coreutils: bare `ls`, `cat`, `cp`, `mv`, `rm`, `sort`,
`echo`, `pwd`, `sleep`, `tee` are `Get-ChildItem`, `Get-Content`, `Copy-Item`, `Move-Item`,
`Remove-Item`, `Sort-Object`, `Write-Output`, `Get-Location`, `Start-Sleep`, `Tee-Object` — not
the real binaries. `ls -la` therefore errors or silently does something else. Use the dedicated
tool; where GNU semantics are genuinely required, use the `.exe` form.

| Never | Use instead |
|---|---|
| `Get-ChildItem -Recurse \| Select-String` | `rg -n <pattern>` |
| `Get-ChildItem -Recurse -Filter` | `rg --files -g '<glob>'` |
| `Get-Content <file>` | `bat -p <file>` |
| `Measure-Object -Line` | `wc -l` |
| `Copy-Item` / `Move-Item` / `Remove-Item -Recurse` | `cp.exe -r` / `mv.exe` / `rm.exe -r` |
| `Compare-Object` | `git diff --no-index` |
| `Test-Path` | `ls.exe <path>` |

`rg` is the default: gitignore-aware (so `target`, `node_modules`, `dist` are skipped when
ignored), parallel, PCRE2 via `-P`. Never assemble a recursive `Get-ChildItem |
Select-String` pipeline — on a Cargo workspace it is the slowest thing in the session. Note
`AGENTS.md` §5's `grep -ri 'api[_-]?key\s*='` is the GNU `grep` from coreutils and works as written;
prefer `rg -i 'api[_-]?key\s*='` when a type or path glob narrows the search.

PowerShell stays correct for: registry, services, event logs, WMI/CIM, `Start-Process`,
`Invoke-RestMethod`, `Get-Command`, `cargo`, `pnpm`, and anything COM or .NET.

> **Why this file exists at all.** The global rules in `~/.config/opencode/AGENTS.md` already carry
> this same trap and table. It is repeated here because on a Cargo workspace the cost of assembling
> the forbidden `Get-ChildItem | Select-String` pipeline is measured in minutes, not milliseconds —
> and because a repo-local copy is what a subagent or a fresh session will actually read. If the two
> ever disagree, the global file is the newer one and this copy is the bug.