#!/usr/bin/env python3
"""Doc consistency checks for the Clauro spec suite.

Runs in CI with no dependencies. Catches the class of drift that four internal
audits missed because each of them scoped itself to DECISIONS.md: a correction
landed in the canonical file and every *restatement* of it went stale.

Exit 0 = clean. Exit 1 = at least one FAIL (printed to stdout).
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAIL: list[str] = []
WARN: list[str] = []


def read(name: str) -> str:
    p = ROOT / name
    if not p.exists():
        FAIL.append(f"missing file: {name}")
        return ""
    return p.read_text(encoding="utf-8")


def docs() -> list[str]:
    return sorted(p.name for p in ROOT.glob("*.md"))


DECISIONS = read("DECISIONS.md")

# ── 1. D-number integrity ────────────────────────────────────────────────────
# The em-dash form is the definition. A bare ^**D\d+ matches wrapped inline
# cross-references and produces false positives -- that mistake was made twice.
DEFINED = {int(m) for m in re.findall(r"^\*\*D(\d+) — ", DECISIONS, re.M)}
if DEFINED:
    hi = max(DEFINED)
    gaps = [i for i in range(1, hi + 1) if i not in DEFINED]
    if gaps:
        FAIL.append(f"DECISIONS.md: D-number gap(s): {gaps}")
    dupes = re.findall(r"^\*\*D(\d+) — .*", DECISIONS, re.M)
    seen: dict[str, int] = {}
    for d in dupes:
        seen[d] = seen.get(d, 0) + 1
    d2 = [k for k, v in seen.items() if v > 1]
    if d2:
        FAIL.append(f"DECISIONS.md: duplicate D definitions: {d2}")

# ── 2. every D-ref in every doc resolves ────────────────────────────────────
for name in docs():
    body = read(name)
    if name == "DECISIONS.md":
        continue
    for d in sorted({int(m) for m in re.findall(r"\bD(\d+)\b", body)}):
        if d not in DEFINED:
            FAIL.append(f"{name}: references D{d}, which is not defined")

# ── 3. declared D-range headers match reality ───────────────────────────────
hi = max(DEFINED) if DEFINED else 0
for name in docs():
    body = read(name)
    for m in re.finditer(r"D1[–-]D(\d+)", body):
        claimed = int(m.group(1))
        if claimed != hi:
            FAIL.append(
                f"{name}: claims D1–D{claimed} but D{hi} exists (stale range header)"
            )

# ── 4. task count vs PHASES.md ──────────────────────────────────────────────
tasks = sorted(p.name for p in (ROOT / "Tasks").glob("*.md"))
n = len(tasks)
phases = read("PHASES.md")
declared = re.search(r"[Ss]even phases, ([a-z-]+) tasks", phases)
words = {
    "twenty-two": 22, "twenty-three": 23, "twenty-four": 24,
    "twenty-five": 25, "twenty-six": 26, "twenty-seven": 27,
    "twenty-eight": 28,
    "thirteen": 13, "fourteen": 14, "fifteen": 15,
}
if declared:
    got = words.get(declared.group(1))
    if got != n:
        FAIL.append(
            f"PHASES.md: declares '{declared.group(1)}' tasks, Tasks/ has {n}"
        )

# ── 5. every task referenced by PHASES.md exists ────────────────────────────
for ref in set(re.findall(r"`?Tasks/(\d{3}-[a-z0-9-]+)\.md`?", phases)):
    if f"{ref}.md" not in tasks:
        FAIL.append(f"PHASES.md: references Tasks/{ref}.md which does not exist")

# ── 6. crate names: ARCHITECTURE vs TECH_STACK ───────────────────────────────
ts = read("TECH_STACK.md")
arch = read("ARCHITECTURE.md")
canon = set(re.findall(r"clauro-[a-z]+", ts))
for c in canon:
    if c not in arch:
        FAIL.append(f"ARCHITECTURE.md: crate '{c}' from TECH_STACK.md is missing")
for c in set(re.findall(r"clauro-[a-z]+", arch)):
    if c not in canon and c not in {"clauro-app"}:
        FAIL.append(f"ARCHITECTURE.md: crate '{c}' is not in TECH_STACK.md")

# ── 7. DDL table count vs the counts asserted in prose ───────────────────────
contracts = read("CONTRACTS.md")
ddl = len(re.findall(r"^CREATE TABLE ", contracts, re.M))
for name in docs():
    body = read(name)
    for m in re.finditer(r"(?:all |the )?([a-z]+) tables", body):
        w = m.group(1)
        got = words.get(w.replace("-", "")) or words.get(w)
        if got is not None and got != ddl:
            FAIL.append(
                f"{name}: says '{m.group(0)}' but CONTRACTS.md §1 defines {ddl} CREATE TABLEs"
            )

# ── 8. SPEC.md is the normative scope; derived docs may not contradict ──────
spec = read("SPEC.md")
spec_tools = set(re.findall(r"^\| `([a-z-]+)` \|", spec, re.M))
if spec_tools:
    for name in ("CONTRACTS.md", "DESIGN.md", "FEATURES.md"):
        body = read(name)
        for tool in ("memory", "artifact", "compact", "bash", "question",
                     "web-search", "web-fetch", "fs"):
            if f"`{tool}`" in body and tool not in spec_tools:
                WARN.append(f"{name}: mentions tool '{tool}' not listed in SPEC.md §2")

# ── 9. personal paths must not live in a public spec ─────────────────────────
for name in docs():
    body = read(name)
    for pat, what in [
        (r"/home/[a-z]+/", "an absolute home path"),
        (r"C:\\\\Program Files", "a Windows install path"),
        (r"6\.18\.33\.2-microsoft", "a host kernel version"),
        (r"/mnt/[a-z]", "a WSL mount path"),
    ]:
        if re.search(pat, body):
            WARN.append(f"{name}: contains {what} (belongs in a gitignored dev-host doc)")

# ── 10. attribution: four sources attributed, no banned source as a row ─────
# Rows only, deliberately: the exclusions are stated in prose (naming a
# repository in a sentence is not a claim to have taken from it), while a row
# *is* a claim, so a banned name may never appear in one. D59/D60/D103.
notices = read("THIRD_PARTY_NOTICES.md")
if notices:
    rows = [ln for ln in notices.splitlines() if ln.startswith("|")]
    for src in ("OpenCode", "DeepSeek Harness", "LibreChat", "shadcn/ui"):
        hit = [r for r in rows if src in r]
        if not hit:
            FAIL.append(f"THIRD_PARTY_NOTICES.md: no attribution row for '{src}'")
        elif not any("github.com" in r for r in hit):
            FAIL.append(
                f"THIRD_PARTY_NOTICES.md: the '{src}' row carries no repository URL"
            )
    for banned in ("LobeHub", "Open WebUI"):
        if any(banned in r for r in rows):
            FAIL.append(
                f"THIRD_PARTY_NOTICES.md: '{banned}' is listed as a source, but it is "
                f"observation-only (D59/D60/D103)"
            )

# ── 11. no first-party vendor wording: doc URLs are cited, never quoted ─────
# D39. A quoted fragment sitting beside a citation is the shape a pasted
# documentation quote takes. Deliberately NARROW: it cannot detect reused
# wording in general, only that shape. Windowed, not line-scoped - the instance
# this was written for (clauro-loop/tests/run.rs, 2026-10-13) wrapped its quote
# across two lines, which a per-line check cannot see.
VENDOR_DOC = re.compile(
    r"platform\.claude\.com|support\.claude\.com|docs\.anthropic\.com|ai\.google\.dev"
)
QUOTE = re.compile(r'"[^"]{25,}"|“[^”]{25,}”')
SCAN_SUFFIXES = {".md", ".rs", ".ts", ".tsx", ".js", ".mjs"}
SKIP_DIRS = {"node_modules", "target", "dist", ".git"}
for p in sorted(ROOT.rglob("*")):
    if not p.is_file() or p.suffix not in SCAN_SUFFIXES:
        continue
    if SKIP_DIRS & set(p.relative_to(ROOT).parts):
        continue
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    for i, ln in enumerate(lines):
        if not VENDOR_DOC.search(ln):
            continue
        window = "\n".join(lines[max(0, i - 2) : i + 3])
        if QUOTE.search(window):
            FAIL.append(
                f"{p.relative_to(ROOT)}:{i + 1}: a quoted fragment sits beside a "
                f"first-party doc citation - paraphrase it and cite the URL (D39)"
            )

# ── report ──────────────────────────────────────────────────────────────────
for w in WARN:
    print(f"WARN  {w}")
for f in FAIL:
    print(f"FAIL  {f}")
print(f"\n{len(DEFINED)} decisions · {n} tasks · {ddl} CREATE TABLE · {len(FAIL)} fail, {len(WARN)} warn")
sys.exit(1 if FAIL else 0)