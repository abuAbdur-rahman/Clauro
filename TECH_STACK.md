# Clauro — TECH_STACK.md

**Licence: MIT.** Public repo. Chosen because every implementation we port from is MIT — attribution
is then a real obligation rather than a courtesy, and the research assumed open source throughout.

---

## 1. Runtime

| | Choice | Why this and not the obvious alternative |
|---|---|---|
| Shell | **Tauri v2** (Rust) | Chromium-free. WebView2 on Windows, WebKitGTK on Linux. ~25 MB binary vs ~150 MB for Electron. |
| Language (shell) | **Rust, 2021 edition** | Required by Tauri. Also the right language for a process runner and a path-safety layer. |
| Language (web) | **TypeScript 5.x, strict** | The whole contract surface is types. `strict` is non-negotiable. |
| UI | **React 19** | The ecosystem and the concurrent-rendering model suit a streaming transcript. |
| Build | **Vite 7** | Fast HMR; the production build is what lands in the binary. |
| Styling | **Tailwind 4** | No-build-step utilities. Also the reason artifacts can be told to use *only* predefined classes. |
| State | **Zustand** | One store, no context ceremony. The transcript is a flat append-only list — a reducer would be overkill. |
| Persistence | **SQLite via `rusqlite`** (bundled) | Single file, WAL, synchronous. No ORM. `CONTRACTS.md` §1 is 12 tables of DDL we write by hand. |
| Serialisation | **`serde`** | Rust boundary. |
| Validation | **Zod** at every boundary | Tool inputs are untrusted. No `any` crosses into the tool host. |
| Secrets | **`keyring`** crate | OS keychain. Windows Credential Manager, libsecret on Linux. Never touches SQLite. |

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
│  └─ clauro-fs/        workspace tree, path safety, process runner.
│                       CONTRACTS.md §1 Windows rules, §3 fs/bash contracts.
└─ src-tauri/           Tauri shell: commands, capabilities, CSP assembly.
                        The only crate that knows Tauri exists.
└─ src/                 React 19 web app.
```

**Dependency rule:** `clauro-core` depends on nothing but `serde`. Dependencies point inward. A
handler in `clauro-tools` may not import `tauri`.

## 3. Transport

| | Choice | Why |
|---|---|---|
| Protocol | **SSE**, hand-rolled over `reqwest` | There is **no official Anthropic Rust SDK** (max 0.0.8, last updated 2024-09-03) and both SSE crates are unmaintained — heavily used, so abandoned-not-dead. We do not build on either. |
| HTTP | **`reqwest`** with `rustls` | Avoids an OpenSSL system dependency, which matters for cross-distro packaging. |
| Streaming | `bytes` → incremental UTF-8 decode → line frame → event parse | Must handle events split across chunk boundaries. |
| Retry | Transport-level backoff on 429/5xx, honouring `Retry-After` | No agent-level retry concept in v1. |

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
ubuntu-latest        WebKitGTK system version   Linux, primary
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
| `reqwest-eventsource` / `eventsource-stream` | Unmaintained. Hand-rolled instead, with fixtures. |
| A JS/Rust transpiler for artifacts | Sucrase, in-browser. The compile must happen client-side because the artifact runs client-side. |
| A local embedding model | ~200 MB. Would triple the binary for a v3 feature. Embeddings are a remote API, opt-in. |
| macOS / WKWebView | Dropped from scope. Windows is the low-risk platform; Linux is the open one. |

## 7. Version pinning

Cargo.lock and package-lock.json are committed. Tauri, Tailwind and the `rusqlite` bundled SQLite
are pinned exactly — an unpinned SQLite changes the schema layer underneath the append-only
guarantee without any commit that mentions it.

Toolchain is pinned in `rust-toolchain.toml` and `.nvmrc`. CI fails on drift rather than warning.

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
| Frontend | Windows-side node/npm/pnpm. |
| Artefacts | A local build directory. Never committed — `target/` is gitignored. |
| Cross-compilation | **Not used, and not needed.** One platform, one toolchain. |

Install paths and exact build numbers are **not** recorded here. They belong to whichever machine you
are on, they change when a toolchain updates, and a spec that carries `C:\Program Files\…` is wrong
the moment anyone else clones it. The rule that generalises: **the spec records the topology, the
machine records the versions.**

Linux remains a shipped target with its own CI floor (`D89`, `D50`, `Tasks/021`); Linux CI runs on
GitHub's runners, not on a developer machine, so nothing in this section depends on having Linux
locally.

