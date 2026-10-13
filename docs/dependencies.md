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

These are installed but are not part of Tauri's template, so each gets the full record:
licence, URL, rejected alternative, maintenance state **as checked on the date in its Verified row**.

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

### 4.5 `shiki` (npm) — syntax highlighting for code blocks

Adopted 2026-10-12 for transcript and composer-preview code blocks (`src/features/transcript/codeblocks.ts`).

| Field | Value |
|---|---|
| Package | `shiki` **4.5.0** |
| Licence | **MIT** — compatible |
| URL | https://www.npmjs.com/package/shiki · https://github.com/shikijs/shiki |
| Maintenance | Current major, actively maintained at check date. |
| Verified | 2026-10-12 (npm registry; `shiki/core` + JavaScript regex engine, no WASM, no `eval`) |

**Rejected:**

| Alternative | Why not |
|---|---|
| `highlight.js` 11.12.0 | **BSD-3-Clause** — outside the §5a allowlist (MIT/ISC/Apache-2.0/CC0). Also ships a ~40-grammar common bundle marked `sideEffects`, which limits tree-shaking. Recorded in `TECH_STACK.md` §6. |
| Hand-rolled regex tokeniser | A decade of edge cases (raw strings, nested comments, template literals) re-discovered by us; §5a's textbook case. |
| Prism | CSS-class-token model would require shipping a theme stylesheet through the transcript's sanitiser path; shiki's DOM-enhancement pass keeps colours out of the purifier's scope entirely. |

Wired as a **post-sanitisation DOM pass**: `renderMarkdown` stays plaintext, and `enhanceCodeBlocks` colourises the already-purified `<pre><code>` by copying shiki's token nodes in — nothing re-enters the string-HTML path.

### 4.6 Verification note (2026-10-12, audit 43) — the four "missing" Rust rows dissolve

Audit 43 asked for dated §5a rows for `dirs`, `uuid`, `chrono`/`time`, and `pulldown-cmark`
"or whichever markdown crate". **All four dissolve on inspection — none is a direct dependency,
so §5a has nothing to record.** Verified by reading every `[dependencies]` and
`[build-dependencies]` block in the workspace:

| Claimed missing | Verdict |
|---|---|
| `dirs` | **Not a direct dep.** No crate lists it. |
| `uuid` | **Not a direct dep.** Thread/project ids are opaque strings chosen by us, not UUIDs. |
| `chrono` / `time` | **Not a direct dep.** Timestamps ride `rusqlite`'s own types. |
| `pulldown-cmark` | **No Rust markdown crate exists at all.** The transcript's markdown engine is the **npm** package `marked` ^18.1.0 (`package.json:36`), purified by `dompurify` and highlighted by `shiki` (§4.5). |

The complete set of **external direct Rust dependencies** is nine, and each already has its record
or its §6 entry: `serde`, `serde_json`, `rusqlite`, `html2text`, `reqwest`, `sha2`, `keyring` (§4.1),
`tauri`/`tauri-build` (§2, D92 pin). Everything else in `Cargo.lock` is transitive, and §5a's
"record the reference" duty attaches to what *we* choose, not to what a chosen crate pulls in.
The `glib` advisory (§6.1) is the one worked example of a transitive dep being tracked anyway —
because it carried an open advisory, not because transitivity alone demands a row.

**npm runtime dependencies — the four-part record, continued.** §4.3 (`zustand`), §4.4 (`zod`) and
§4.5 (`shiki`) already carry it. The remainder, which §5a also covers:

| Package | Licence | Why it is here / rejected alternative | Verified |
|---|---|---|---|
| `marked` ^18.1.0 | **MIT** | Markdown → HTML for the transcript. **Rejected: `pulldown-cmark`** — would have put a Rust markdown parser on the transcript path for no gain, since the render target is a browser DOM, not a terminal; and **`markdown-it`** — larger, plugin-model surface we do not need under a strict purifier allowlist (D100). Always used **behind DOMPurify**, never trusted directly (`markdown.ts` comment: trusting `marked`'s own escaping leaves a hole a new feature can reopen). | 2026-10-12 (`package.json:36`) |
| `dompurify` ^3.4.16 | **MPL-2.0** | The purifier on both HTML paths (transcript `markdown.ts`, artifact SVG `sanitize.ts`). File-level copyleft — fine for bundling, and the one npm licence outside the MIT/ISC/Apache/CC0 allowlist that §6.1 of `TECH_STACK.md` tolerates. **Rejected: hand-rolled escaping** — the exact class of bug D100 exists to prevent. Loaded **dynamically** so ~100 KB is not paid on every launch. | 2026-10-12 (`package.json:34`) |
| `sucrase` ^3.35.1 | **MIT** | In-browser JSX/TS transform for artifacts, inside a Worker with a timeout and an output cap (D4). **Rejected: Babel** — an order of magnitude heavier for a transform-only need; **rejected: bundling a JS runtime** — D110 ships a 20-line `h()` instead, so no second component model enters the security boundary. | 2026-10-12 (`package.json:40`) |
| `zustand` ^5.0.15 | **MIT** | Frontend state. See §4.3. | 2026-10-04 |
| `zod` ^4.6.5 | **MIT** | Boundary validation. See §4.4. | 2026-10-04 |
| `react` / `react-dom` ^19.1.0 | **MIT** | The UI framework; version matches the Tauri v2 template. **Rejected: solid/svelte** — no Tauri-template parity, and React 19 is what the shell code and the vendored shadcn primitives are written against. | 2026-10-04 (template) |
| `@tauri-apps/api` ^2.12.1 | **MIT OR Apache-2.0** | The IPC surface. Pinned to the same version as the `tauri` crate (D92) — a version skew between the JS API and the Rust runtime is exactly the class of mismatch that made the D124 internals object observable. | 2026-10-12 |
| `zustand`-adjacent UI kit: `@radix-ui/*` (11 packages), `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `lucide-react` | **MIT** (cva: Apache-2.0) | App-shell-only primitives, vendored or pinned per D112/D96/D127. Full per-package record and rejected alternatives in **§7** below. Radix never enters the artifact frame (D2, D3, D83). | 2026-10-12 |

**Advisory-scan status, dated (audit 43 asked for this to be recorded rather than assumed):**

| Scan | Status | Date |
|---|---|---|
| `pnpm audit --json` | **Clean — 0 vulnerabilities across 329 packages.** | 2026-10-11 (audit 43) |
| `cargo audit` | **NOT INSTALLED on this host → the Rust advisory scan has never been executed.** This is a real gap, not a pass. Trivy (in `ci.yml`) does scan `Cargo.lock`, but its advisory check is **report-only** and does not fail the build, so no gate currently enforces Rust advisories. | recorded 2026-10-12 |
| Trivy (CI) | Runs on every push: vulnerabilities, secrets, misconfiguration. **Report-only for advisories** until `Tasks/022` wires a failing gate. | live |

> **The `cargo audit` gap is the honest open item here.** It belongs to `Tasks/022` (packaging and
> dependency audit), which is still open in Phase 6. Until that task lands, the Rust advisory state
> is *unknown*, and the §6 register above is built from Dependabot alerts rather than from a full
> advisory sweep. Do not read "no §6 entry" as "no advisory" — read it as "no advisory *found by the
> two tools that actually ran*". (`deny-workflow.yml` does **not** exist in this repo, so the audit
> 43 suggestion to check whether it already runs `cargo deny` resolves to: there is nothing to check
> — the workflows are `ci.yml`, `malware-ioc.yml` and `release.yml`.)

**npm licence diversity, measured (audit 43 FYI, run 2026-10-12):** `npx license-checker --summary
--production` over the production tree reports **MIT ×21, (Apache-2.0 OR MIT) ×1
(`@tauri-apps/api`), Apache-2.0 ×1 (`class-variance-authority`), (MPL-2.0 OR Apache-2.0) ×1
(`dompurify`), ISC ×1, UNLICENSED ×1** — the UNLICENSED entry is the root package itself, which
carries no `"license"` field in `package.json` (the repo's `LICENSE` file is MIT; adding the field
is a one-line packaging fix left to the packaging owner). **No copyleft (GPL/AGPL) runtime
dependency**; the only non-permissive-adjacent licence is dompurify's file-level MPL, already
recorded in `TECH_STACK.md` §7.1 and tolerated by §6.1.

### 4.7 `tauri-plugin-single-instance` (Rust) — second-instance handoff

| Field | Value |
|---|---|
| Crate | `tauri-plugin-single-instance` **2.5.3** (resolved, `Cargo.lock`) |
| Licence | **Apache-2.0 OR MIT** — compatible |
| URL | https://crates.io/crates/tauri-plugin-single-instance · https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/single-instance |
| Maintenance | tauri-apps' official plugin workspace. 2.5.3 released **2026-10-10**; 8.98M downloads (4.66M recent). |
| Verified | 2026-10-13 (crates.io API) |

**Why it is in.** `Tasks/020` acceptance: *"A second instance activates the first rather than
launching a second."* The plugin owns the platform single-instance handshake and, per its own docs,
must be registered **first** among the app's plugins so a second instance hands off before any other
plugin's setup runs — which is the order `src-tauri/src/lib.rs` uses. The callback focuses the main
window (`summon::focus_main`).

**Rejected:**

| Alternative | Why not |
|---|---|
| Hand-rolled per-platform handshake (Win32 `CreateMutexW` + broadcast, an abstract Unix socket, the macOS equivalent) | Three platform protocols plus teardown races (already-exists paths, a stale socket after a crash) — §5a's "hand-rolled is the expensive instinct", on a surface where being wrong means two instances fighting over one hotkey. |
| No guard — let a second window open | Fails 020's acceptance criterion outright. |
| `3.0.0-alpha.2` of the same plugin | Alpha on a **D50 release-blocker** surface (the Linux floor). The stable 2.x line is what ships. |

### 4.8 `tauri-plugin-global-shortcut` (Rust) — the global summon chord

| Field | Value |
|---|---|
| Crate | `tauri-plugin-global-shortcut` **2.4.1** (resolved, `Cargo.lock`) |
| Licence | **Apache-2.0 OR MIT** — compatible |
| URL | https://crates.io/crates/tauri-plugin-global-shortcut · https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut |
| Maintenance | tauri-apps' official plugin workspace (wraps the `global-hotkey` crate). 2.4.1 released **2026-10-10**; 4.42M downloads (1.91M recent). |
| Verified | 2026-10-13 (crates.io API) |

**Why it is in.** `Tasks/020` acceptance: *"The hotkey is globally registered and released cleanly
on quit"*, with conflicts falling back to the in-app chord **and saying so**. Registration happens
host-side in `setup` (`src-tauri/src/lib.rs`, recorded through `summon::record`), so the outcome is
*reported* by `summon_hotkey_status` rather than assumed. On Windows the underlying API is
`RegisterHotKey`, which consumes the press — the webview keydown listener cannot double-fire while
the chord is live, and the in-app listener stays as the fallback when registration failed.

**Rejected:**

| Alternative | Why not |
|---|---|
| Hand-rolled `RegisterHotKey`/`UnregisterHotKey` + X11/DBus on Linux + `NSEvent` global monitors on macOS | Three backends, each with its own lifetime rules (macOS must register and dispatch on the main thread), plus release-on-quit choreography — the wheel §5a names as the example not to rebuild. |
| `global-hotkey` crate directly (the plugin's own dependency) | Then we own the Tauri lifecycle glue — setup timing, state, error surfacing — the official plugin already ships. The plugin is the supported entry point over the same crate. |

**Note (scope, recorded so it is not re-litigated):** only the summon chord (Ctrl+K) is global.
Settings (Ctrl+,) stays in-app deliberately — one global chord, no competition between them — see
`useSettingsHotkey` in `src/features/shell/hotkey.ts`. The frontend's `react-hotkeys-hook` row in §5
is unaffected: the in-app listeners are two keydown handlers, still not a dependency.

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
| Syntax highlight | `shiki` | 4.5.0 | MIT | **Adopted 2026-10-12** — see §4.5. TextMate grammars, no `eval`. |
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

### 7.1 Chat batch (`Tasks/026`) — components deleted under **D130**

| Package | Resolved | Licence | Use |
|---|---|---|---|
| ~~`@radix-ui/react-avatar`~~ | ~~1.2.6~~ | MIT | **Removed 2026-10-13 (D130):** `avatar.tsx` was part of the never-wired chat batch; the dependency leaves with it |
| `@radix-ui/react-dropdown-menu` | **2.1.24** | MIT | Rail thread/project menus (`ProjectsRail`) — survives the batch deletion |
| `@radix-ui/react-progress` | **1.1.16** | MIT | Compaction/usage progress (`ChatView`, `ProjectDetail`) — survives the batch deletion |
| ~~`@radix-ui/react-scroll-area`~~ | ~~1.2.18~~ | MIT | **Removed 2026-10-13 (D130):** `scroll-area.tsx` was part of the never-wired chat batch; the dependency leaves with it |

**Deleted, with reason (D130, 2026-10-13).** The Task 026 chat-batch components (`Bubble`,
`Message`, `Avatar`, `Attachment`, `Alert`, `Badge`, `Spinner`, `Marker`, `Empty`, `ScrollArea`)
were vendored fresh from the shadcn registry and never wired — the transcript and composer
hand-roll their own rows — so they sat at "implemented, tested, no caller" (AGENTS §7a) and
guaranteed drift against the surfaces that ship. Deleted rather than adopted; their two exclusive
Radix dependencies (`react-avatar`, `react-scroll-area`) leave with them, and the batch's smoke
test is trimmed to what ships (`ui-kit.test.tsx`). `dropdown-menu` and `progress` stay, used by the
rail and the usage displays.

**Deferred with owner:** ~~`message-scroller` follow-output in `@shadcn/react`~~ — moot for the
kit: `ScrollArea`/`Message` are deleted (D130), and the transcript's own scroller owns
follow-output in `006`.

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