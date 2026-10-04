# Clauro — TECH_STACK.md

**Licence: MIT.** Public repo. Chosen because every implementation we port from is MIT — attribution
is then a real obligation rather than a courtesy, and the research assumed open source throughout.

---

## 1. Runtime

| | Choice | Why this and not the obvious alternative |
|---|---|---|
| Shell | **Tauri v2** (Rust) | Chromium-free. WebView2 on Windows, WebKitGTK on Linux. ~25 MB binary vs ~150 MB for Electron. Pinned at **2.12.1**, far above the CVE-2024-35222 fix. |
| Language (shell) | **Rust, 2021 edition** | Required by Tauri. Also the right language for a process runner and a path-safety layer. |
| Language (web) | **TypeScript 6.0, strict** | The whole contract surface is types. `strict` is non-negotiable. **Pinned to what Tauri's own `react-ts` template ships** — see §1.1. |
| UI | **React 19** | The ecosystem and the concurrent-rendering model suit a streaming transcript. |
| Icons | **`lucide-react`** (ISC) | 1,600+ inline-SVG components, tree-shakable ES modules. App shell only — see §1.2. **D96.** |
| Build | **Vite 8** | Fast HMR; the production build is what lands in the binary. Rolldown-based. |
| Styling | **Tailwind 4** via `@tailwindcss/vite` | No-build-step utilities. Also the reason artifacts can be told to use *only* predefined classes. |
| State | **Zustand** | One store, no context ceremony. The transcript is a flat append-only list — a reducer would be overkill. |
| Persistence | **SQLite via `rusqlite`** (bundled) | Single file, WAL, synchronous. No ORM. `CONTRACTS.md` §1 is 12 tables of DDL we write by hand. |
| Serialisation | **`serde`** | Rust boundary. |
| Validation | **Zod 4** at every boundary | Tool inputs are untrusted. No `any` crosses into the tool host. |
| Secrets | **`keyring`** crate | OS keychain. Windows Credential Manager, libsecret on Linux. Never touches SQLite. |

### 1.1 TypeScript is pinned to Tauri, not to latest

`typescript` is pinned to **`~6.0.3`**, which is what `create-tauri-app`'s `react-ts` template
declares. This is a deliberate choice against a newer release.

TypeScript **7.0** is the native Go compiler, stable since 2026-07-08, and it is 8–12× faster on
typecheck. It is not adopted yet. TS 6.0 is the final JavaScript-based release and the documented
bridge to 7 — its stated purpose is retiring legacy defaults and aligning the compiler with modern
JavaScript. Two reasons to hold at 6:

- **Tauri's template pins it.** Matching the template exactly is what makes scaffold drift
  mechanical rather than something a human has to notice.
- **Type-aware tooling is still catching up.** The `tsgo` programmatic Language Service API is not at
  parity; type-aware lint rules are the gap.

**Rule:** moving to TS 7 is a deliberate, separately-committed bump with its own task — never a
transitive `npm update`. The compiler may change; the contract surface may not.

### 1.2 Icons: `lucide-react`, app shell only

`lucide-react` **1.51.0**, ISC-licensed, peer-depends on React `^19` — it is compatible with React 19
by declaration, not by hope. Chosen because every icon is an inline `<svg>` element and the package is
fully tree-shakable, so we import named components and never ship the full set.

**Scope is the app shell.** Icons for the chat title, the incognito ghost (**D37**), the crossed-out
memory indicator (**D9**), and the command palette come from `lucide-react`.

**Icons inside artifacts are a v2 concern and are not vendored in v1.** Artifacts run in an opaque
origin with no network (`D2`, `D3`), so a model-written artifact cannot import from `node_modules` —
and an external SVG sprite referenced by `<use href="…#id">` is already known to break on WebKit
under `default-src 'none'`. When artifacts get icons, the icons are **inlined SVG paths**, and the
vendoring step gets its own task and its own D-number. **D96.**

## 2. Cargo workspace

One crate per concern, because `CONTRACTS.md` §7 promises tests that run **without a webview, without
a network, and without a provider**. A single crate entangles the transport with Tauri types and that
promise becomes unpayable.

```
clauro/
├─ crates/
│  ├─ clauro-core/      domain types: ContentBlock, ToolOutcome, Measurement.
│  │                    No I/O, no dependencies beyond serde. The type layer.
│  ├─ clauro-store/     SQLite. CONTRACTS.md §1 DDL verbatim. rusqlite only.
│  ├─ clauro-transport/ SSE parsing + the two provider adapters. CONTRACTS.md §5.
│  ├─ clauro-tokens/    TokenMeter + CompactionPolicy. CONTRACTS.md §4.
│  │                    Pure arithmetic over injected measurement — no provider calls.
│  ├─ clauro-tools/     the eight handlers + registry + permission resolution.
│  │                    CONTRACTS.md §3.
│  ├─ clauro-loop/      serial turn loop + system prompt + queue.
│  │                    CONTRACTS.md §2, §3. May use core/store/transport/tools.
│  └─ clauro-fs/        workspace tree, path safety, process runner.
│                       CONTRACTS.md §1 Windows rules, §3 fs/bash contracts.
└─ src-tauri/           Tauri shell: commands, capabilities, CSP assembly.
                        The only crate that knows Tauri exists.
└─ src/                 React 19 web app.
```

**Dependency rule:** `clauro-core` depends on nothing but `serde`. Dependencies point inward. A
handler in `clauro-tools` may not import `tauri`. `clauro-loop` may use core, store, transport and
tools — never `tauri`.

## 3. Transport

| | Choice | Why |
|---|---|---|
| Protocol | **SSE**, hand-rolled over `reqwest` | There is **no official Anthropic Rust SDK** (max 0.0.8, last updated 2024-09-03). We do not build on an SDK. See §3.1 for why not an SSE crate either. |
| HTTP | **`reqwest`** with `rustls` | Avoids an OpenSSL system dependency, which matters for cross-distro packaging. |
| Streaming | `bytes` → incremental UTF-8 decode → line frame → event parse | Must handle events split across chunk boundaries. |
| Retry | Transport-level backoff on 429/5xx, honouring `Retry-After` | No agent-level retry concept in v1. |

### 3.1 Why not an SSE crate — re-checked 2026-10-04

The four rules in `CONTRACTS.md` §5 are **Anthropic event semantics**, not SSE framing:
`signature_delta` on an empty-rendering block, `input_transformations` on two different events,
`usage.iterations` after a compaction, unknown events never fatal. A crate would hand us the framing
layer and leave every one of those four to us anyway — and each needs a fixture.

**Correction to the previous text in this document.** It claimed *both* SSE crates were unmaintained.
That is no longer true, and a false claim in a spec is worse than a missing one:

| Crate | Latest | Last release | Verdict |
|---|---|---|---|
| `reqwest-eventsource` | 0.6.0 | 2024-03-29 | Abandoned. Heavily used, so widely depended on. |
| `eventsource-stream` | 0.2.3 | 2022-02-17 | Abandoned, four years stale. |
| `reqwest-sse` | 0.2.0 | **2026-05-08** | **Maintained.** MIT. But 6 stars, 1 maintainer. |

`reqwest-sse` is the honest alternative and it is recorded here rather than dismissed. It is not
adopted because it covers only the framing layer we would still have to own, and a transport with one
maintainer and six stars is a supply-chain surface we would be adding to the most load-bearing crate in
the project. If it reaches a real release cadence, this decision is revisited — **D97.**

**The parser is where the bugs live.** Four rules from `CONTRACTS.md` §5 are not optional and each
has a fixture:

1. An unrecognised event is `ignored`, never fatal.
2. `signature_delta` is captured even when the block renders empty.
3. `input_transformations` is read on `message_start` *and* the final `message_delta`.
4. After a compaction response, usage comes from `usage.iterations` — top-level tokens are **zero**.

## 4. Testing

| | Choice | Why |
|---|---|---|
| Rust | **`cargo test`**, no webview | The point of the workspace. Core, tokens, fs and transport are all testable headless. |
| Web | **Vitest** | Matches the Vite build. |
| Integration | **`tauri-driver` + WebDriver**, Windows + Linux CI | For the two things that cannot be tested headless: the webview sandbox and the keyring round-trip. |
| Fixtures | Recorded SSE transcripts under `crates/clauro-transport/tests/fixtures/` | Omitted thinking, a compaction response, a dropped block, an unknown event. Synthetic, not captured from a live key. |

**No test requires a live API key.** That is a design constraint, not a convenience: a test that
needs a key is a test that silently stops running.

## 5. CI matrix

`D50` — the floor is the oldest LTS tier with **WebKitGTK 2.40+**. The matrix is the real contract,
because Cargo ships WebKit2GTK sys crates while distro-native builds differ again.

```
ubuntu-24.04         WebKitGTK system version   Linux, primary
ubuntu-24.04         WebKitGTK 2.4x, older      Linux, floor
windows-latest       WebView2 (evergreen)       Windows, primary
windows-latest + fixed-version WebView2 runtime   Windows, floor
```

Four jobs. Two are floors, and floors are where the sandbox gate gets falsified — so a floor failure
is a **release blocker**, not a warning.

**Corrected 2026-10-04 by external audit.** Two of the original labels were not testable floors:

- **`ubuntu-22.04` is not a floor.** Deprecation began 2026-09-17 and it is unsupported from
  2027-04-17, so the job had roughly six months of life left while still being labelled the floor.
  `ubuntu-24.04` is the oldest runner carrying a WebKitGTK new enough to be meaningful.
- **`windows-2019` is not in the current runner label set** — the job could not have been scheduled.
- **"Older WebView2" was never a property of a runner image.** The Windows floor is not achieved by
  picking an older OS image; it is achieved by installing a **Fixed Version** WebView2 runtime
  explicitly, which is what the fourth job now does.

A floor is a *runtime version*, not a runner label. Recording the resolved version in the job log is
part of the job, otherwise the next person cannot tell what was actually tested.

## 6. Explicitly rejected

| Rejected | Why |
|---|---|
| Electron | Defeats the size and RAM thesis outright. |
| An ORM (Drizzle, sqlx) | `CONTRACTS.md` §1 is hand-written DDL by decision. An ORM obscures the append-only constraint that D19 depends on. |
| Official Anthropic Rust SDK | 0.0.8, two years stale. |
| `reqwest-eventsource` / `eventsource-stream` | Abandoned. See §3.1 — including the correction that a third crate now exists and *is* maintained. |
| `reqwest-sse` | Maintained and MIT, but framing-only (see §3.1) and six stars. Revisit at real release cadence — **D97.** |
| Hand-rolled icons / inline SVG paths in app UI | **D96.** `lucide-react` is tree-shakable, ISC, React 19-compatible, and 1,600+ icons. Drawing our own is a worse wheel. |
| `react-icons` 5.7.0 | Aggregates *many* icon sets, so bundle analysis is per-set and brand logos are reintroduced — exactly what Lucide 1.0 removed for trademark reasons. |
| `@radix-ui/react-icons` 1.3.2 | Fifteen icons. Not a library, a garnish. |
| `feather-icons` 4.29.2 | Last released **2024-05-01**. Lucide was forked from it and is actively maintained; this is the abandoned original. |
| `material-symbols` 0.47.6 | An icon *font* — 13 MB unpacked, plus `font-src` in a CSP we want narrow. Wrong delivery mechanism for a desktop binary. |
| `@mui/icons-material` 9.4.0 | Declares a hard peer dependency on `@mui/material`. Adopting the icons would adopt Material Design. |
| A JS/Rust transpiler for artifacts | Sucrase, in-browser. The compile must happen client-side because the artifact runs client-side. |
| A local embedding model | ~200 MB. Would triple the binary for a v3 feature. Embeddings are a remote API, opt-in. |
| macOS / WKWebView | Dropped from scope. Windows is the low-risk platform; Linux is the open one. |

### 6.1 Rules for adopting a dependency

Recorded 2026-10-04. This project has no interest in rebuilding what already exists well, and the
instinct to hand-roll is the expensive one.

1. **Search before writing.** Before implementing anything non-trivial, check whether a library
   already does it. This applies to `similar` (text diff) and `notify` (filesystem watching) exactly
   as it applies to icons. Hand-rolling a diff is a bug farm with a nice UI.
2. **Vet it, then cite it.** Licence must be MIT/ISC/Apache-2.0-compatible with our MIT licence.
   Maintenance is checked — last release date and open-issues state, not download count alone.
   Downloads reward abandonment: `eventsource-stream` has 25M downloads and died in 2022.
3. **Record the reference.** Every adopted dependency gets a row here with the URL, the version
   adopted, and the alternative that was rejected and why. A dependency with no recorded alternative
   has not been justified.
4. **Adopt the maintained thing, not the popular thing.** Six stars with a release last month beats
   six hundred thousand downloads with no release since 2022. Prefer the boring, currently-shipped
   dependency.
5. **A dependency crossing a boundary needs a D-number.** Anything added inside the artifact sandbox
   or the tool host is a security-surface change, not a convenience — see `AGENTS.md` §8.

## 7. Version pinning

Cargo.lock and pnpm-lock.yaml are committed. Tauri, Tailwind and the `rusqlite` bundled SQLite
are pinned exactly — an unpinned SQLite changes the schema layer underneath the append-only
guarantee without any commit that mentions it.

Toolchain is pinned in `rust-toolchain.toml` and `.nvmrc`. The frontend package manager is pinned
via the `packageManager` field in `package.json` (`pnpm@11.6.0`) — CI installs with
`pnpm install --frozen-lockfile` and fails on drift rather than warning. The Rust pin lives only in
`rust-toolchain.toml`; CI extracts the channel from that file instead of hardcoding a second copy.

### 7.1 Pinned versions, verified 2026-10-04

Recorded so a reader can tell a stale claim from a deliberate one. **The spec states the rules; this
table is the evidence that the rules were applied.**

| Component | Pinned | Note |
|---|---|---|
| `typescript` | `~6.0.3` | Matches the Tauri template exactly. §1.1. |
| `vite` | `^8.0.16` | Matches the Tauri template. Rolldown-based. |
| `@vitejs/plugin-react` | `^6.1.1` | Peer-requires Vite `^8.0.0` — this is why Vite 8 is not optional. |
| `react` / `react-dom` | `^19.1.0` | |
| `tailwindcss` + `@tailwindcss/vite` | `4.3.x` | Vite 8 support merged into `@tailwindcss/vite`. |
| `lucide-react` | `1.51.0` | ISC. Peer-declares React `^19`. §1.2, **D96.** |
| `zod` | `^4` | v4, not v3. Boundary validation (`docs/dependencies.md` §4.4). |
| `zustand` | `^5.0.15` | MIT. One store, no context ceremony. `docs/dependencies.md` §4.3. |
| `vitest` | `^5` | Peer-supports Vite `^8.0.0`. |
| `eslint` + `typescript-eslint` | `^10` + `^8` | `strictTypeChecked`, `no-explicit-any`, `no-console` as **errors** — §4. |
| `@tauri-apps/cli` / `api` | `^2.12.1` | ≥ the CVE-2024-35222 fix. **D92.** |
| `tauri` / `tauri-build` (Rust) | `2.12.1` / `2.7.1` | |
| `reqwest` (Rust) | `0.13.x` → **0.13.1** | `rustls` + `webpki-roots`, no OpenSSL. `docs/dependencies.md` §4.2. |
| `rusqlite` (Rust) | `0.40.x` | `bundled`. |
| `serde_json` (Rust) | `1.x` | `serde`'s only sane JSON impl; hand-rolled parsing rejected. In tree since 003 (catalogue); store adopts same for block payloads. |
| `keyring` (Rust) | `4.x` → **4.2.0** | MIT/Apache-2.0, released 2026-08. `docs/dependencies.md` §4.1. |

**Node:** the toolchain targets **Node 24 LTS** (`.nvmrc`), which is what Vite 8 and the current
`@tauri-apps/cli` expect.

### 7.2 Wheels already identified, for when the task that needs them lands

Not dependencies yet — nothing here is installed. These were checked against the registry on
2026-10-04 so that when the owning task arrives the choice is already researched. **Each still gets
its own task, and each still needs a `TECH_STACK.md` row before it is installed.**

| Need | Candidate | Licence | Verdict |
|---|---|---|---|
| Text diff | `similar` 3.2.0 | MIT/Apache | Adopt for `fs` diff rendering. Do not hand-roll a diff. |
| Filesystem watching | `notify` 8.2.0 | CC0/MIT | Adopt for the workspace tree. |
| Virtualised transcript | `@tanstack/react-virtual` 3.14 | MIT | Likely — a long thread is a flat append-only list that must not render every block. |
| Markdown in transcript | `react-markdown` 10.1 | MIT | Likely. Sanitisation is ours to get right; not a default-export decision. |
| Syntax highlight | `shiki` 4.5 | MIT | Likely. TextMate grammars, no eval. |
| Command palette | `cmdk` 1.1.1 | MIT | Likely for **D42/D44**. |
| Hotkeys | `react-hotkeys-hook` 5.3 | MIT | Likely for **D66**. |
| SSE framing | `reqwest-sse` 0.2.0 | MIT | **Not adopted** — §3.1, **D97.** |
| Pseudo-terminal for `bash` | `portable-pty` 0.9.0 | MIT | Open question for **D28/D30** — a pty changes signal and exit-code semantics. |

**Recording these is the point.** A dependency researched once and written down is not re-litigated
in the task that needs it, and the alternative it beat is on the record.

---

> The concrete paths, toolchain versions and host quirks are machine-specific. They live in
> **`docs/dev-host.md`, which is gitignored.** This table states the *rules*; that file records
> *one host*. Putting a `/home/<user>` path or an SDK build number in a public spec makes it
> wrong the moment anyone else clones it.

## 8. Build and test topology

Development is **natively Windows**: the repo lives on the Windows filesystem, builds with the
Windows toolchain in a Windows shell, and needs no cross-compilation and no interoperability layer.

| | |
|---|---|
| Source of truth | The repo, on the Windows filesystem. |
| Build | Windows `cargo`/`rustc`, target `x86_64-pc-windows-msvc`, linked by MSVC. |
| Frontend | Windows-side node/pnpm. |
| Artefacts | A local build directory. Never committed — `target/` is gitignored. |
| Cross-compilation | **Not used, and not needed.** One platform, one toolchain. |

Install paths and exact build numbers are **not** recorded here. They belong to whichever machine you
are on, they change when a toolchain updates, and a spec that carries `C:\Program Files\…` is wrong
the moment anyone else clones it. The rule that generalises: **the spec records the topology, the
machine records the versions.**

Linux remains a shipped target with its own CI floor (`D89`, `D50`, `Tasks/021`); Linux CI runs on
GitHub's runners, not on a developer machine, so nothing in this section depends on having Linux
locally.

**Development is Windows-only for now (`AGENTS.md` §8a, decided 2026-10-04).** WebKitGTK development
headers are not installed on the development host and require a sudo password an agent cannot supply,
so the Linux half of any engine-dependent verdict is executed in CI rather than locally. This is a
sequencing decision: **the WebView2 verdict is the one that gates a release, and the WebKitGTK
verdict is best-effort** (`D89`). Until the Linux column is genuinely run, it reads "not run on this
host" — never "verified".

