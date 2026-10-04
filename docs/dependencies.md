# Dependency research record

**Purpose.** This is the evidence behind `TECH_STACK.md` §6 and §7.2 and `AGENTS.md` §5a. Every entry
was checked against the live registry on the date stated — not recalled from memory.

**How to use this file.** Before adding a dependency, look here first: the research may already be
done. If your dependency is not here, add it, with the same fields. A dependency with no recorded
alternative has not been justified.

**Check commands used** (both are cheap, both are the first step):

```powershell
npm view <pkg> version license peerDependencies time.modified
(Invoke-WebRequest "https://crates.io/api/v1/crates/<name>").Content | ConvertFrom-Json
```

---

## 1. Adopted — `lucide-react`

| Field | Value |
|---|---|
| Package | `lucide-react` |
| Version | **1.51.0** |
| Licence | **ISC** — compatible with our MIT |
| URL | https://www.npmjs.com/package/lucide-react · https://lucide.dev |
| React peer range | `^16.5.1 \|\| ^17 \|\| ^18 \|\| ^19` — **React 19 supported by declaration** |
| Scope | **App shell only** (`TECH_STACK.md` §1.2, **D96**) |
| Verified | 2026-10-04 |

**Why it won.** Every icon is an inline `<svg>` element and the package is fully tree-shakable ES
modules, so named imports are the intended usage and the full 1,600+ icon set never reaches the
bundle. Inline SVG is also what the artifact CSP can carry (`data:`/`blob:`) without a network fetch.

**The caveat that shaped the decision — Lucide 1.0 removed all brand icons.** Trademark exposure,
design consistency and maintenance burden; the team points users to brand guidelines for logos. For
Clauro this is not a problem: the icon set in use is the incognito ghost (**D37**), the crossed-out
memory indicator (**D9**), and command-palette affordances — all generic shapes, no logos.

**Rejected:**

| Alternative | Version | Why not |
|---|---|---|
| Hand-rolled SVG paths | — | 1,600+ icons already exist, debugged, and free. Re-drawing them is a worse wheel. |
| `react-icons` | 5.7.0 | Aggregates many icon sets, so bundle analysis is per-set and brand logos return — exactly what Lucide 1.0 removed. |
| `@radix-ui/react-icons` | 1.3.2 | Fifteen icons. Not a library, a garnish. |
| `feather-icons` | 4.29.2 | Last released **2024-05-01**. This is the abandoned original Lucide was forked from. |
| `material-symbols` | 0.47.6 | An icon *font* — 13 MB unpacked, plus `font-src` in a CSP we want narrow. Wrong delivery mechanism for a desktop binary. |
| `@mui/icons-material` | 9.4.0 | Hard peer dependency on `@mui/material`. Adopting the icons adopts Material Design. |

**Why app-shell-only, and why that is a security statement.** Artifacts run in an opaque origin with
no network (`D2`, `D3`), so a model-written artifact cannot import from `node_modules`. An external
SVG sprite via `<use href="...#id">` is already known to break on WebKit under `default-src 'none'`
(`DECISIONS.md`, the renderer-specific trap under D83). When artifacts get icons — **v2** — they are
inlined SVG paths, and the vendoring step gets its own task and its own D-number.

---

## 2. Version pins — verified against what Tauri actually ships

The reference point is `create-tauri-app`'s `react-ts` template
(`templates/template-react-ts/package.json.lte`, branch `dev`), read 2026-10-04:

```json
"@vitejs/plugin-react": "^6.0.2",
"typescript": "~6.0.3",
"vite": "^8.0.16",
"react": "^19.1.0",
```

### 2.1 TypeScript — `~6.0.3`, not 7.0.2

TypeScript **7.0** is the native Go compiler, stable since **2026-07-08**, and 8–12× faster on
typecheck. It is not adopted. Two reasons:

1. **Tauri pins 6.0.3.** Matching the template exactly is what makes scaffold drift mechanical rather
   than something a human has to notice.
2. **Type-aware tooling is still catching up.** The `tsgo` programmatic Language Service API is not
   at parity (Astro roadmap, Feb 2026); type-aware lint rules are the gap.

TS 6.0 is documented as the final JavaScript-based release and the bridge to 7 — its stated purpose
is retiring legacy defaults and aligning the compiler with modern JavaScript. Holding at 6 is
therefore a *supported* position, not a stale one.

**Rule:** moving to TS 7 is a deliberate, separately-committed bump with its own task. Never a
transitive `npm update`. The compiler may change; the contract surface may not.

### 2.2 Everything else, resolved from a real install

Installed in `spikes/sandbox-probe` and read back out of `package-lock.json`:

| Component | Pinned | Resolved | Note |
|---|---|---|---|
| `typescript` | `~6.0.3` | **6.0.3** | Matches Tauri. |
| `vite` | `^8.0.16` | **8.3.2** | Rolldown-based. |
| `@vitejs/plugin-react` | `^6.0.2` | **6.1.1** | Peer-requires Vite `^8.0.0` — this is why Vite 8 is not optional. |
| `react` / `react-dom` | `^19.1.0` | **19.3.0** | |
| `@tauri-apps/api` / `cli` | `^2` | **2.12.1** | ≥ the CVE-2024-35222 fix. |
| `tailwindcss` + `@tailwindcss/vite` | `4.3.x` | — | Vite 8 support merged into `@tailwindcss/vite`. |
| `zod` | `^4` | 4.6.5 | v4, not v3. |
| `vitest` | `^5` | 5.0.3 | Peer-supports Vite `^8.0.0`. |
| `tauri` (Rust) | `=2.12.1` | — | Pinned **exactly**; the IPC-injection rule is version-dependent (**D92**). |
| `tauri-build` (Rust) | `=2.7.1` | — | |
| `reqwest` (Rust) | 0.13.x | 0.13.5 | `rustls` only. |
| `rusqlite` (Rust) | 0.40.x | 0.40.2 | `bundled`. |
| `keyring` (Rust) | 4.x | 4.2.0 | |

**Note on the React 19 / plugin-react peer graph.** `@vitejs/plugin-react` 6.x declares optional peers
on `oxc-transform-react`, `@rolldown/plugin-babel` and `babel-plugin-react-compiler`. These are
optional; the spike builds and runs without them. Do not add a React Compiler without its own task.

---

## 3. The SSE decision — a false claim, corrected

`TECH_STACK.md` previously said *"both SSE crates are unmaintained — heavily used, so
abandoned-not-dead."* **That is no longer true.** Verified 2026-10-04:

| Crate | Latest | Last release | Downloads (recent) | Verdict |
|---|---|---|---|---|
| `reqwest-eventsource` | 0.6.0 | **2024-03-29** | 11.6M | Abandoned. Heavily depended on. |
| `eventsource-stream` | 0.2.3 | **2022-02-17** | 25.5M | Abandoned, four years stale. |
| `reqwest-sse` | 0.2.0 | **2026-05-08** | 116k | **Maintained.** MIT. **6 stars, 1 maintainer.** |

`reqwest-sse` is the honest alternative and is recorded rather than dismissed. It is **not adopted**:

1. **It covers only the framing layer we would still own.** The four rules in `CONTRACTS.md` §5 are
   Anthropic event *semantics* — `signature_delta` on an empty-rendering block, `input_transformations`
   read on two different events, `usage.iterations` after a compaction, unknown events never fatal. A
   crate hands us bytes→events and leaves every one of those to us, each needing a fixture.
2. **Supply chain on the most load-bearing crate in the project.** Six stars and one maintainer on the
   transport is a risk we would be choosing, not inheriting.

**Revisit condition, recorded so it is not re-litigated:** if `reqwest-sse` reaches a real release
cadence — more than one maintainer, or a non-trivial dependent base — this decision is reopened.
**D97.**

**Generalisable lesson, now in `AGENTS.md` §5a:** downloads reward abandonment.
`eventsource-stream` has 25M downloads and no release since 2022.

---

## 4. Identified, vetted, NOT installed

Researched so the owning task does not repeat it. **Nothing here is a dependency yet.** Each still
needs its own task, and its own `TECH_STACK.md` row before it lands (`AGENTS.md` §5).

| Need | Candidate | Version | Licence | Verdict |
|---|---|---|---|---|
| Text diff for `fs` | `similar` | 3.2.0 | MIT/Apache | **Adopt when `010` lands.** Do not hand-roll a diff — a bug farm with a nice UI. |
| Filesystem watch for the workspace tree | `notify` | 8.2.0 | CC0/MIT | **Adopt when `010` lands.** |
| Virtualised transcript | `@tanstack/react-virtual` | 3.14.13 | MIT | **Likely.** A long thread is a flat append-only list that must not render every block. |
| Markdown in transcript | `react-markdown` | 10.1.0 | MIT | **Likely.** Sanitisation is ours to get right; not a default-export decision. |
| Syntax highlight | `shiki` | 4.5.0 | MIT | **Likely.** TextMate grammars, no `eval`. |
| Command palette | `cmdk` | 1.1.1 | MIT | **Likely for D42/D44.** |
| Hotkeys | `react-hotkeys-hook` | 5.3.3 | MIT | **Likely for D66.** |
| Pseudo-terminal for `bash` | `portable-pty` | 0.9.0 | MIT | **Open question for D28/D30.** A pty changes signal and exit-code semantics; do not adopt without reading that task. |
| SSE framing | `reqwest-sse` | 0.2.0 | MIT | **Not adopted** — §3. **D97.** |

**Deliberately not researched yet.** Tauri plugins (`plugin-dialog`, `plugin-fs`, `plugin-shell`) are
plausible but are *security-surface* additions inside the tool host (`AGENTS.md` §8). The task that
needs one owns the decision.