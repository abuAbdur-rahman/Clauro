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
| Maintenance | **Active** — latest release **1.52.0** published **2026-10-04** (npm registry, checked the same day); we pin 1.51.0 |
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
| `eslint` + `typescript-eslint` | `^10` + `^8` | 10.12.0 / 8.71.0 | `strictTypeChecked`; `no-explicit-any` and `no-console` configured as errors. |
| `tauri` (Rust) | `=2.12.1` | — | Pinned **exactly**; the IPC-injection rule is version-dependent (**D92**). |
| `tauri-build` (Rust) | `=2.7.1` | — | |
| `reqwest` (Rust) | 0.13.x | 0.13.1 | `rustls` + `webpki-roots` only, no OpenSSL. Resolved from `Cargo.lock`. |
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

## 4. Adopted by the workspace — records required by `AGENTS.md` §5a

These four are installed but are not part of Tauri's template, so each gets the full record:
licence, URL, rejected alternative, maintenance state **as checked on 2026-10-04**.

### 4.1 `keyring` (Rust) — OS keychain

| Field | Value |
|---|---|
| Crate | `keyring` **4.2.0** (resolved, `Cargo.lock`) |
| Licence | **MIT OR Apache-2.0** — compatible |
| URL | https://crates.io/crates/keyring · https://github.com/open-source-cooperative/keyring-rs |
| Maintenance | Latest 4.2.0 released **2026-08-29** — one month before the check. 28.9M downloads. |
| Verified | 2026-10-04 (crates.io API) |

**Rejected:**

| Alternative | Why not |
|---|---|
| Hand-rolled Win32 `CredRead`/`CredWrite` + libsecret FFI | Two platform backends, per-platform test matrices, and every error-classification edge re-discovered by us. The textbook case of §5a's "hand-rolled is the expensive instinct". |
| Secrets in SQLite or a config file | Forbidden outright: `CONTRACTS.md` §6 ("API key read from the OS keychain; never written to SQLite, never logged"). |
| `secrecy` / `zeroize` | Correct *wrappers* for zeroising memory, but no storage backend at all. They solve a different layer. |

### 4.2 `reqwest` (Rust) — HTTP transport

| Field | Value |
|---|---|
| Crate | `reqwest` **0.13.1** (resolved, `Cargo.lock`; registry latest 0.13.5 at check date) |
| Licence | **MIT OR Apache-2.0** — compatible |
| URL | https://crates.io/crates/reqwest · https://github.com/seanmonstar/reqwest |
| Features | `default-features = false`, `rustls` + `webpki-roots` + `json` — **no OpenSSL**. |
| Maintenance | Actively maintained; crate updated **2026-09-08**. 767M downloads. |
| Verified | 2026-10-04 (crates.io API) |

**Rejected:**

| Alternative | Why not |
|---|---|
| `native-tls` / OpenSSL default features | A system OpenSSL dependency on every distro we package for — the exact cost `rustls` avoids (§1 "HTTP" row). |
| `ureq` | Sync-only HTTP. The shell is Tokio under Tauri and SSE streaming (005) wants async; a sync client means a thread-per-request or `block_on` at the boundary. |
| `attohttpc` / `isahc` | Smaller and less maintained on the most load-bearing transport in the project — the same star-count argument as **D97**. |

Note: `reqwest` here covers the **catalogue fetch** (003). The SSE framing layer stays hand-rolled
per **D24/D97**; `reqwest` is the byte pipe underneath it either way.

### 4.3 `zustand` (npm) — frontend state

| Field | Value |
|---|---|
| Package | `zustand` **^5.0.15** (resolved 5.0.15) |
| Licence | **MIT** |
| URL | https://www.npmjs.com/package/zustand · https://github.com/pmndrs/zustand |
| Maintenance | Last modified **2026-08-13** — actively maintained. |
| Verified | 2026-10-04 (npm registry) |

**Rejected:**

| Alternative | Why not |
|---|---|
| Redux Toolkit | Middleware, actions, reducers, devtools ceremony for a state shape that is one flat append-only thread list. Boilerplate buys nothing at this size. |
| React Context + `useReducer` | Re-render granularity: every consumer re-renders on any thread update, which is the wrong default for a streaming transcript. |
| `jotai` | Atoms suit derived state; Clauro has one authoritative store per thread. Reach for atoms when a real derivation graph appears — not before. |

### 4.4 `zod` (npm) — boundary validation

| Field | Value |
|---|---|
| Package | `zod` **^4.6.5** (resolved 4.6.5 — v4, not v3) |
| Licence | **MIT** |
| URL | https://www.npmjs.com/package/zod |
| Maintenance | Last modified **2026-10-02** — two days before the check. |
| Verified | 2026-10-04 (npm registry) |

**Rejected:**

| Alternative | Why not |
|---|---|
| `valibot` | Smaller bundle, but schema inference into TS types is the feature we use at every boundary, and Zod v4 closed most of the size gap while keeping the ecosystem (Tauri/React examples, form libs) on its side. |
| `ajv` | JSON Schema, not TypeScript-first: the type has to be written twice and then kept in sync by hand — exactly the drift the contract surface exists to prevent. |
| Hand-written type guards | `CONTRACTS.md` shapes arrive from the host and from disk; a hand-written guard per shape is a bug farm with a type annotation. |

---

## 5. Identified, vetted, NOT installed

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

---

## 7. Adopted for the app shell — vendored shadcn (`Tasks/025`, **D112**)

Checked against the live registry on 2026-10-06. shadcn is a copy, not a
package: Radix primitives plus `cva`/`clsx`/`tailwind-merge` pasted into
`src/components/ui/`, so vendoring *is* the install and each file carries no
version of its own — the versions below are the npm packages underneath.

| Package | Resolved | Licence | URL | Maintenance (checked 2026-10-06) |
|---|---|---|---|---|
| `@radix-ui/react-dialog` | **1.1.23** | MIT | https://www.npmjs.com/package/@radix-ui/react-dialog | Active Radix line, registry-fresh Oct 2026 |
| `@radix-ui/react-select` | **2.3.7** | MIT | https://www.npmjs.com/package/@radix-ui/react-select | Active Radix line, registry-fresh Oct 2026 |
| `@radix-ui/react-separator` | **1.1.15** | MIT | https://www.npmjs.com/package/@radix-ui/react-separator | Active Radix line, registry-fresh Oct 2026 |
| `@radix-ui/react-slot` | **1.3.3** | MIT | https://www.npmjs.com/package/@radix-ui/react-slot | Active Radix line, registry-fresh Oct 2026 |
| `@radix-ui/react-tooltip` | **1.2.16** | MIT | https://www.npmjs.com/package/@radix-ui/react-tooltip | Active Radix line, registry-fresh Oct 2026 |
| `@radix-ui/react-collapsible` | **1.1.20** | MIT | https://www.npmjs.com/package/@radix-ui/react-collapsible | Active Radix line, registry-fresh Oct 2026 |
| `@radix-ui/react-label` | **2.1.15** | MIT | https://www.npmjs.com/package/@radix-ui/react-label | Active Radix line, registry-fresh Oct 2026 |
| `class-variance-authority` | **0.7.1** | Apache-2.0 — compatible | https://www.npmjs.com/package/class-variance-authority | Stable — 2024-11-26; the API surface is frozen, not abandoned |
| `clsx` | **2.1.1** | MIT | https://www.npmjs.com/package/clsx | Active — 2026-09-18 |
| `tailwind-merge` | **3.7.0** | MIT | https://www.npmjs.com/package/tailwind-merge | Active — 2026-09-13 |
| `tw-animate-css` | **1.4.0** | MIT | https://www.npmjs.com/package/tw-animate-css | Active — 2026-02-28 |
| `@testing-library/user-event` (dev) | **14.6.7** | MIT | https://www.npmjs.com/package/@testing-library/user-event | Active — 2026-09-02 |

**Why this won.** Every interactive surface in Phase 5 (rail, approval
dialog, model picker, palette) needs focus trapping, portal layering, and
keyboard handling. Radix owns exactly that layer and shadcn owns the Tailwind
theme wiring over it. A hand-rolled dialog is a bug farm with a focus trap.

**Rejected:**

| Alternative | Why not |
|---|---|
| Hand-rolled Sidebar/Dialog/Select | Focus traps, `aria` wiring, and portal stacking re-discovered by us — the expensive instinct (§5a) |
| `tailwindcss-animate` 1.0.7 | Tailwind v3 JS plugin, stale since 2023; `tw-animate-css` is the v4 CSS-native line |
| `cmdk` for the palette shell (now) | Recorded, not removed — `Tasks/020` decides with the behaviour in front of it |
| `@radix-ui/react-icons` | Fifteen icons (decided already in **D96**) |

**Scope is the app shell, exactly like `lucide-react` (D96).** Nothing Radix
ever enters the artifact frame (`D2`, `D3`, `D83`).

---

## 6. Known open advisories — deferred with reasons

An open advisory nobody wrote down is an open advisory nobody owns. `Tasks/022` re-audits this
register at release; each entry names the trigger that brings it back into scope before then.

### 6.1 `glib` — unsound `Iterator` impls (Dependabot #2)

| Field | Value |
|---|---|
| Alert | Dependabot **#2**, opened 2026-10-04, severity **medium** |
| Package | `glib` **0.18.5** — transitive, `Cargo.lock`, Linux targets only (tauri → gtk chain) |
| Advisory | Unsoundness in `Iterator` and `DoubleEndedIterator` impls for `glib::VariantStrIter` |
| Affected / patched | `>=0.15.0, <0.20.0` / **0.20.0** — so the locked 0.18.5 is affected |
| Reachable surface here | The unsound iterator walks D-Bus `GVariant` strings. Clauro's own code never touches it; the reachable path runs through tauri/gtk internals, and Clauro speaks no D-Bus. A real advisory, a negligible surface — not a dismissal. |
| Why it cannot be fixed yet | **Proven, not assumed** — `cargo update -p glib --precise 0.20.0 --dry-run` (2026-10-04) fails with `gtk v0.18.2 requires glib ^0.18`, `gtk` required by `tauri =2.12.1`. 0.20.0 does not resolve against the chain. |
| Revisit trigger | (a) a `glib 0.18.x` backport of the fix, (b) a tauri release raising its gtk/glib floor, or (c) `Tasks/022`'s release audit — whichever comes first. |
| Deferred by | user decision, 2026-10-04 |