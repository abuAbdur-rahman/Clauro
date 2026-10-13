//! Clauro shell. The only crate that knows Tauri exists.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artifact_doc;
mod catalogue;
mod csp;
mod keyring_store;
mod platform;
mod providers;
mod summon;
mod turn;

use tauri::Manager;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use catalogue::{
    is_fresh, read_cache, resolve, write_cache, CatalogueError, CATALOGUE_TTL_SECS, MODELS_DEV_URL,
};
use keyring_store::KeyringError;
use platform::WebviewStatus;

// ── keyring commands ───────────────────────────────────────────────────────

#[tauri::command(async)]
fn keyring_delete(account: String) -> Result<(), KeyringError> {
    keyring_store::delete(&account)
}

#[tauri::command(async)]
fn keyring_available() -> Result<(), KeyringError> {
    keyring_store::is_available()
}

// ── catalogue commands ─────────────────────────────────────────────────────

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CatalogueError> {
    app.path()
        .app_data_dir()
        .map_err(|e| CatalogueError::CorruptCache {
            reason: format!("no app-data dir: {e}"),
        })
}

/// Reads and parses the whole 5.3 MB cache: `async` so that work lands on a
/// runtime worker, never on the WebView2 IPC thread (A-perf-ipc).
#[tauri::command(async)]
fn catalogue_status(app: tauri::AppHandle) -> Result<serde_json::Value, CatalogueError> {
    let dir = cache_dir(&app)?;
    let now = now_secs();
    match read_cache(&dir)? {
        None => Ok(serde_json::json!({ "state": "absent" })),
        Some(cached) => {
            let fresh = is_fresh(cached.modified_secs, now, CATALOGUE_TTL_SECS);
            let cat = catalogue::parse_catalogue(&cached.bytes)?;
            Ok(serde_json::json!({
                "state": if fresh { "fresh" } else { "stale" },
                "models": cat.model_count(),
            }))
        }
    }
}

/// Cache degradation policy for the boot path: an UNREADABLE cache is an
/// absent cache. `read_cache` keeps its typed error for callers that report
/// on cache state (`catalogue_status`); a refresh must never abort on the
/// fallback it is merely trying to consult (PR #2 finding).
fn cache_or_none(dir: &std::path::Path) -> Option<catalogue::CacheRead> {
    read_cache(dir).ok().flatten()
}

#[tauri::command]
async fn catalogue_refresh(app: tauri::AppHandle) -> Result<serde_json::Value, CatalogueError> {
    let dir = cache_dir(&app)?;
    let cached = cache_or_none(&dir);
    let fresh_bytes = fetch_models_dev().await;
    let result = match fresh_bytes {
        Ok(bytes) => {
            // Cache what we fetched; a failed write must not fail the refresh.
            let _ = write_cache(&dir, &bytes);
            resolve(Some(&bytes), cached.as_ref())
        }
        Err(net_err) => {
            // Failed fetch yields cached data, not a broken picker.
            match resolve(None, cached.as_ref()) {
                Ok((cat, _)) if cat.model_count() > 0 => {
                    return Ok(serde_json::json!({
                        "state": "cached",
                        "models": cat.model_count(),
                        "catalogue": cat,
                        "notice": net_err.to_string(),
                    }))
                }
                _ => return Err(net_err),
            }
        }
    };
    let (cat, from_cache) = result?;
    Ok(serde_json::json!({
        "state": if from_cache { "cached" } else { "live" },
        "models": cat.model_count(),
        "catalogue": cat,
    }))
}

async fn fetch_models_dev() -> Result<Vec<u8>, CatalogueError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| CatalogueError::Network {
            reason: format!("cannot build client: {e}"),
        })?;
    let resp = client
        .get(MODELS_DEV_URL)
        .send()
        .await
        .map_err(|e| CatalogueError::Network {
            reason: format!("fetch failed: {e}"),
        })?;
    if !resp.status().is_success() {
        return Err(CatalogueError::Network {
            reason: format!("HTTP {}", resp.status()),
        });
    }
    // Bound the response: the catalogue is ~5.3 MB, and a hostile or broken
    // server must not stream an arbitrary body into memory (review 13 NIT).
    // The declared length is refused before the body is read; the actual
    // length is refused after, for servers that lie or omit it.
    if resp
        .content_length()
        .is_some_and(|len| len > catalogue::MAX_CACHE_BYTES)
    {
        return Err(CatalogueError::Network {
            reason: format!(
                "catalogue response is over the {} byte cap",
                catalogue::MAX_CACHE_BYTES
            ),
        });
    }
    let bytes = resp.bytes().await.map_err(|e| CatalogueError::Network {
        reason: format!("cannot read body: {e}"),
    })?;
    if bytes.len() as u64 > catalogue::MAX_CACHE_BYTES {
        return Err(CatalogueError::Network {
            reason: format!(
                "catalogue response is over the {} byte cap",
                catalogue::MAX_CACHE_BYTES
            ),
        });
    }
    Ok(bytes.to_vec())
}

// ── artifact policy ─────────────────────────────────────────────────────────

/// The artifact frame's CSP for one render (D3). The web app asks for this
/// value and embeds it; it cannot supply its own, and `csp.rs` holds the only
/// copy. Nothing in the shell's own policy can widen this one: multiple
/// policies intersect, so the frame keeps the stricter of the two.
#[tauri::command]
fn artifact_csp(nonce: String) -> String {
    csp::artifact_csp(&nonce)
}

/// Publish one render's artifact document (D123). The web app hands over the
/// envelope and the nonce it was built with and gets back the absolute URL the
/// frame navigates to; the response header is assembled from that same nonce,
/// so the document's single policy and its tags can never disagree.
#[tauri::command]
fn artifact_publish(
    registry: tauri::State<'_, artifact_doc::DocRegistry>,
    nonce: String,
    doc: String,
) -> Result<String, artifact_doc::DocError> {
    registry.publish(&nonce, &doc)
}

// ── platform commands ──────────────────────────────────────────────────────

/// Reads the WebView2 registry key on Windows: `async` keeps that I/O off
/// the IPC thread — it is one of the first invokes of every launch.
#[tauri::command(async)]
fn webview_status() -> WebviewStatus {
    platform::webview_status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Task 020: single-instance FIRST — the plugin requires it (the
        // second instance must hand off before any other plugin's setup
        // runs). A second launch focuses this instance's main window and
        // exits; it never reaches `run`.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            summon::focus_main(app);
        }))
        // Task 020: the shortcut *plugin* installs here; the shortcut itself
        // registers in setup below, where its outcome can be recorded for
        // `summon_hotkey_status`.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // D123/D124: the artifact documents live on their own `artifact`
        // scheme, registered here through Tauri's public hook. Note what
        // that does and does not buy (tauri-2.12.1 `webview/mod.rs:1961-2002`):
        // the scheme DOES land in Tauri's protocol map, but `is_local_url`'s
        // Windows arm compares the URL's scheme against the tauri ASSET
        // protocol's scheme (`http` != `tauri`), so a document at
        // `http://artifact.localhost/…` resolves `Origin::Remote` and the
        // ACL denies every command (no remote capability — pinned by test in
        // `artifact_doc.rs`, empirically by `scripts/webview-proofs.mjs`
        // claim 1). The shell's own `tauri` scheme keeps its built-in
        // handler untouched, including `csp_header`.
        .register_uri_scheme_protocol(artifact_doc::SCHEME, |ctx, request| {
            artifact_doc::handle_request(ctx.app_handle(), &request)
        })
        .setup(|app| {
            // The turn driver owns its store under the app-data dir. Opening
            // it here (not lazily in the first command) means a corrupt
            // database fails at launch with the real error, not mid-turn.
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| turn::TurnError::Store {
                    reason: format!("no app-data dir: {e}"),
                })?;
            let state =
                turn::TurnState::open(&dir).map_err(|e| format!("cannot open turn store: {e}"))?;
            app.manage(state);
            // The enrichment cache is parsed once per file version and shared
            // by every `provider_models_enriched` invoke — two ModelPickers
            // mount at boot, and without this each one re-read and re-parsed
            // 5.3 MB on the IPC thread (A-perf-ipc). Keyed by mtime inside.
            app.manage(catalogue::EnrichmentMemo::default());
            // Published artifact documents live as long as the app does; the
            // registry is bounded, and a re-render republishes (D123).
            app.manage(artifact_doc::DocRegistry::default());
            // Task 020: register the global summon hotkey and record WHY. A
            // conflict (another app already owns Ctrl+K) degrades to the
            // in-app listener and the Shortcuts pane says so — it must never
            // fail the launch. `on_shortcut` binds the press handler too:
            // the OS ate the keydown, so summon.rs re-delivers it as an
            // event after focusing the window.
            let outcome = app
                .global_shortcut()
                .on_shortcut(summon::REGISTER_SOURCE, |app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        summon::on_global(app);
                    }
                })
                .map_err(|e| e.to_string());
            summon::record(outcome);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keyring_delete,
            keyring_available,
            catalogue_status,
            catalogue_refresh,
            artifact_csp,
            artifact_publish,
            webview_status,
            turn::turn_start,
            turn::turn_stop,
            turn::transcript_read,
            turn::artifact_latest,
            turn::question_answer,
            providers::provider_list,
            providers::provider_add_builtin,
            providers::provider_add_custom,
            providers::provider_remove,
            providers::provider_set_key,
            providers::provider_models,
            providers::provider_models_enriched,
            providers::provider_refresh,
            summon::summon_hotkey_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // PR #2: on the refresh path an unreadable cache must degrade to "no
    // cache", never abort the refresh — a fallback the OS blocks is a
    // fallback the live fetch does not need. The typed error stays in
    // `read_cache` for callers that care about it (`catalogue_status`).
    #[test]
    fn refresh_treats_an_unreadable_cache_as_absent() {
        let dir = std::env::temp_dir().join(format!("clauro-cache-degrade-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        // A directory where the cache file belongs: `read` fails with a
        // non-NotFound error, which `read_cache` reports as CorruptCache.
        std::fs::create_dir_all(dir.join(catalogue::CACHE_FILE)).expect("sabotage");

        assert!(matches!(
            read_cache(&dir),
            Err(CatalogueError::CorruptCache { .. })
        ));
        assert!(cache_or_none(&dir).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// True when the `#[tauri::command]` attribute that precedes `fn <name>`
    /// is `async`-marked, or the function itself is `async fn`.
    ///
    /// The reason this is worth pinning: tauri-macros 2.7.1 runs a plain sync
    /// command INLINE wherever the invoke arrives (`command/wrapper.rs`
    /// `body_blocking` → `$path(...)` before responding), which on Windows is
    /// the WebView2 IPC callback — the UI thread. Every read, keychain call,
    /// and parse in such a command stalls repaint and input for its whole
    /// duration. `#[tauri::command(async)]` / `async fn` route the body
    /// through `async_runtime::spawn` instead (`body_async`).
    fn command_is_async(src: &str, name: &str) -> bool {
        // The needle is assembled at runtime so this test's own source cannot
        // satisfy it (same trick as `generic_keyring_commands_are_not_registered`).
        let decl = format!("fn {}(", name);
        let Some(fn_at) = src.find(&decl) else {
            return false;
        };
        let Some(attr_at) = src[..fn_at].rfind("#[tauri::command") else {
            return false;
        };
        src[attr_at..fn_at].contains("async")
    }

    // Every command that touches the filesystem, the keychain, SQLite, the
    // network, or a 5.3 MB parse runs off the IPC thread. Deliberately NOT
    // on this list: `artifact_csp` (pure string), `artifact_publish`
    // (in-memory registry), `turn_stop` (one atomic store under a lock) —
    // none does I/O, and a round-trip to the thread pool would cost more
    // than they do.
    #[test]
    fn io_commands_are_marked_async_so_they_leave_the_ipc_thread() {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let targets: &[(&str, &[&str])] = &[
            (
                "src/lib.rs",
                &[
                    "keyring_delete",
                    "keyring_available",
                    "catalogue_status",
                    "catalogue_refresh",
                    "webview_status",
                ],
            ),
            (
                "src/providers.rs",
                &[
                    "provider_list",
                    "provider_add_builtin",
                    "provider_add_custom",
                    "provider_remove",
                    "provider_set_key",
                    "provider_models",
                    "provider_models_enriched",
                    "provider_refresh",
                ],
            ),
            (
                "src/turn.rs",
                &[
                    "turn_start",
                    "transcript_read",
                    "artifact_latest",
                    "question_answer",
                ],
            ),
        ];
        for (file, names) in targets {
            let src = std::fs::read_to_string(manifest.join(file))
                .unwrap_or_else(|e| panic!("{file} is readable: {e}"));
            for name in *names {
                assert!(
                    command_is_async(&src, name),
                    "{file}: `{name}` must be async (async fn or \
                     #[tauri::command(async)]) — a sync command runs on the \
                     WebView2 IPC thread and stalls the UI for its whole duration"
                );
            }
        }
    }

    // The 60-second network fetch leaves the async runtime too, not just the
    // IPC thread: `async fn` bodies run on a runtime worker, and a worker
    // blocked for a minute delays every other command (review 13 FYI).
    #[test]
    fn the_blocking_pool_offloads_the_heavy_command_work() {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        // Assembled at runtime so this test's source cannot satisfy it.
        let heavy = format!("{}_blocking", "spawn");
        let src = std::fs::read_to_string(manifest.join("src/providers.rs"))
            .unwrap_or_else(|e| panic!("src/providers.rs is readable: {e}"));
        assert!(
            src.contains(&heavy),
            "src/providers.rs: the cold-cache fetch and the5.3 MB parse must \
             run on the blocking pool, not on a runtime worker"
        );
    }

    // Review 13, item 3: generic store/retrieve commands took an arbitrary
    // account name and returned the raw secret — the frontend never called
    // them, so they were pure attack surface reachable from any context the
    // ACL allowed. The typed `provider_*` commands cover every real need
    // (provider_set_key / provider_remove drive the keyring internally).
    // The availability probe stays: it reads no secret.
    #[test]
    fn generic_keyring_commands_are_not_registered() {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let lib = std::fs::read_to_string(manifest.join("src/lib.rs")).expect("lib.rs is readable");
        // The needles are assembled at runtime so this very test's source
        // cannot satisfy the `contains` checks below.
        let store_cmd = format!("fn {}(", "keyring_store");
        let retrieve_cmd = format!("fn {}(", "keyring_retrieve");
        assert!(
            !lib.contains(&store_cmd),
            "keyring_store must not exist as a command"
        );
        assert!(
            !lib.contains(&retrieve_cmd),
            "keyring_retrieve must not exist as a command"
        );
        // The keyring module keeps existing for its real callers — the typed
        // provider path and the turn driver, never a generic command.
        assert!(lib.contains("mod keyring_store;"), "the module stays");
        let providers =
            std::fs::read_to_string(manifest.join("src/providers.rs")).expect("readable");
        assert!(
            providers.contains("keyring_store::store"),
            "provider_set_key still writes keys through the keyring module"
        );
        let turn = std::fs::read_to_string(manifest.join("src/turn.rs")).expect("readable");
        assert!(
            turn.contains("keyring_store::retrieve"),
            "turn_start/question_answer still read keys through the keyring module"
        );
    }

    // ── invoke ↔ generate_handler contract (review 40, top-risk 2) ─────────
    //
    // Nothing cross-checked the frontend's `invoke("…")` call sites against
    // the `generate_handler![]` registration. Every layer is mocked
    // (`@tauri-apps/api/core` in vitest, `src/dev/mock-tauri.ts` in the
    // browser harness), so a renamed or deleted Rust command stayed green
    // through every test on both sides and broke only in the shipped app.
    // This test scans both sides of the boundary and asserts the two name
    // sets agree, modulo two explicit allowlists — each entry carries the
    // reason it is allowed to drift, and each entry fails the test once it
    // goes stale, so the lists cannot rot silently.

    use std::collections::BTreeSet;

    /// Registered commands the UI may invoke WITHOUT a registration — each
    /// with the reason the drift is allowed. Empty means "no known drift".
    ///
    /// Was non-empty for `keyring_store`/`keyring_retrieve` while the dead
    /// frontend wrappers existed; A-final deleted them (review 13 item 3's
    /// TODO), so the drift is gone and this list is honestly empty again.
    const FRONTEND_DRIFT: &[(&str, &str)] = &[];

    /// Registered commands with NO frontend caller — each with the reason they
    /// stay registered. Empty means "nothing host-only".
    const HOST_ONLY: &[(&str, &str)] = &[
        (
            "keyring_delete",
            "No production frontend caller (repo-wide grep 2026-10-12): key deletion \
             goes through `provider_remove`, which drives `keyring_store::delete` \
             in-process. Registered for host/manual invocation only (e.g. devtools \
             in a debug build); removing it changes the command ACL and needs a \
             D-number, which is a lead decision, not this test's.",
        ),
        (
            "catalogue_status",
            "Read-only cache-status probe; the UI drives `catalogue_refresh` and \
             never calls status. Registered for host/manual diagnostics only — \
             same ACL/D-number argument as `keyring_delete`.",
        ),
    ];

    /// Production frontend sources: everything under the repo `src/` except
    /// tests (they drive the MOCK, so their command names are arbitrary) and
    /// `src/dev/` (the browser harness — its own header says production
    /// builds never see it, and its `invoke` is a dispatcher, not a call
    /// site). Returns `(relative path, source)` pairs.
    fn frontend_sources() -> Vec<(String, String)> {
        let root = std::path::PathBuf::from(format!("{}/../src", env!("CARGO_MANIFEST_DIR")));
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(top) = stack.pop() {
            for entry in std::fs::read_dir(&top).expect("repo src/ must be listable") {
                let path = entry.expect("dir entry must read").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = path.file_name().expect("file has a name").to_string_lossy();
                if !(name.ends_with(".ts") || name.ends_with(".tsx")) {
                    continue;
                }
                if name.contains(".test.") || name.contains(".spec.") {
                    continue;
                }
                let rel = path.to_string_lossy().replace('\\', "/");
                if rel.contains("/src/dev/") {
                    continue;
                }
                let body = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("{} is readable: {e}", path.display()));
                out.push((rel, body));
            }
        }
        // A walker that finds nothing must fail loudly here, not pass the
        // contract vacuously below.
        assert!(
            !out.is_empty(),
            "repo src/ must yield frontend sources — a moved root is a scan \
             failure, not an empty contract"
        );
        out
    }

    /// Every `invoke("…")` / `invoke('…')` literal first argument in one
    /// source file. Hand-rolled: this crate has no `regex` dependency and
    /// adding one for a two-token scan would be waste (§5a). Skipped
    /// deliberately: invocations whose first argument is not a string
    /// literal (production has none — the only dynamic one is the mock
    /// dispatcher, excluded above) and identifiers merely ending in
    /// `invoke(` (word-boundary guard).
    fn frontend_invokes_in(src: &str) -> Vec<String> {
        let mut names = Vec::new();
        let mut rest = src;
        while let Some(at) = rest.find("invoke(") {
            let after = &rest[at + "invoke(".len()..];
            // Word boundary: `fooInvoke(` / `$invoke(` are not Tauri's
            // `invoke`. A preceding `.` IS accepted — a future
            // `core.invoke("…")` call site must count.
            let prev_ok = at == 0
                || !rest[..at]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$');
            if prev_ok {
                let trimmed = after.trim_start();
                if let Some(q) = trimmed.chars().next().filter(|c| *c == '"' || *c == '\'') {
                    let body = &trimmed[1..];
                    if let Some(end) = body.find(q) {
                        names.push(body[..end].to_string());
                    }
                }
            }
            rest = after;
        }
        names
    }

    /// Command names inside the `generate_handler!` registration in lib.rs,
    /// last path segment only (`turn::turn_start` → `turn_start`). The
    /// needle is assembled at runtime so this test's own source cannot
    /// satisfy the search (same trick as the tests above), and the FIRST
    /// match is the real registration — which precedes this module.
    fn registered_commands(lib_src: &str) -> Vec<String> {
        let open = format!("{}![", "generate_handler");
        let start = lib_src.find(&open).expect("lib.rs registers a handler");
        let after = &lib_src[start + open.len()..];
        let end = after.find(']').expect("the registration list closes");
        // Defend against future inline comments inside the list.
        let body: String = after[..end]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(l))
            .collect();
        body.split(',')
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(|e| {
                e.rsplit("::")
                    .next()
                    .expect("non-empty segment")
                    .to_string()
            })
            .collect()
    }

    /// Both directions of the contract, plus staleness of both allowlists.
    /// Pure so the synthetic test below can prove it bites.
    fn contract_violations(
        frontend: &BTreeSet<String>,
        registered: &BTreeSet<String>,
    ) -> Vec<String> {
        let mut out = Vec::new();
        for name in frontend {
            if !registered.contains(name) && !FRONTEND_DRIFT.iter().any(|(n, _)| n == name) {
                out.push(format!(
                    "frontend invokes `{name}` but the handler list does not \
                     register it — the shipped app would fail this call"
                ));
            }
        }
        for name in registered {
            if !frontend.contains(name) && !HOST_ONLY.iter().any(|(n, _)| n == name) {
                out.push(format!(
                    "`{name}` is registered but no production frontend file \
                     invokes it and it is not in HOST_ONLY"
                ));
            }
        }
        for (name, _) in FRONTEND_DRIFT.iter().copied() {
            if registered.contains(name) {
                out.push(format!(
                    "FRONTEND_DRIFT entry `{name}` is stale: it IS registered now — \
                     remove the entry"
                ));
            }
            if !frontend.contains(name) {
                out.push(format!(
                    "FRONTEND_DRIFT entry `{name}` is stale: no frontend file invokes \
                     it anymore — remove the entry"
                ));
            }
        }
        for (name, _) in HOST_ONLY.iter().copied() {
            if !registered.contains(name) {
                out.push(format!(
                    "HOST_ONLY entry `{name}` is stale: it is no longer registered — \
                     remove the entry"
                ));
            }
            if frontend.contains(name) {
                out.push(format!(
                    "HOST_ONLY entry `{name}` is stale: the frontend now invokes it — \
                     remove the entry"
                ));
            }
        }
        out
    }

    /// The permanent bite-proof (review 6: a test that has never failed
    /// proves nothing): a synthetic pair with one name missing in each
    /// direction must produce a violation naming it. This fails if the
    /// scanner or the comparison ever rots into matching nothing.
    #[test]
    fn the_invoke_contract_check_flags_a_synthetic_mismatch() {
        let frontend: BTreeSet<String> = ["turn_start", "fake_missing_command"]
            .into_iter()
            .map(String::from)
            .collect();
        let registered: BTreeSet<String> = ["turn_start", "fake_uncalled_command"]
            .into_iter()
            .map(String::from)
            .collect();
        let v = contract_violations(&frontend, &registered);
        assert!(
            v.iter().any(|m| m.contains("fake_missing_command")),
            "an invoke the handler list lacks must be flagged: {v:?}"
        );
        assert!(
            v.iter().any(|m| m.contains("fake_uncalled_command")),
            "a registered command nothing invokes must be flagged: {v:?}"
        );
    }

    /// The contract itself: every production `invoke("…")` name is
    /// registered, every registered command has a caller or an explicit
    /// reason, and neither allowlist has gone stale.
    #[test]
    fn frontend_invokes_match_the_registered_handler() {
        let mut frontend = BTreeSet::new();
        for (path, body) in frontend_sources() {
            // A file importing the REAL invoke must call it with a literal:
            // a dynamic call there would slip the contract. Files that do
            // not import it (barrels, views, stores) contribute nothing.
            if body.contains("from \"@tauri-apps/api/core\"") {
                let names = frontend_invokes_in(&body);
                assert!(
                    !names.is_empty(),
                    "{} imports the real invoke but contains no literal invoke \
                     call — either the scanner is stale or the call site became \
                     dynamic",
                    path
                );
                frontend.extend(names);
            } else {
                frontend.extend(frontend_invokes_in(&body));
            }
        }
        // Anchors against a scanner that silently degrades: these two are
        // invoked/registered today and must be seen by the scan.
        assert!(frontend.contains("turn_start"), "scan sees turn_start");
        assert!(
            frontend.contains("artifact_publish"),
            "scan sees artifact_publish"
        );

        let lib_src = std::fs::read_to_string(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
        )
        .expect("lib.rs is readable");
        let registered: BTreeSet<String> = registered_commands(&lib_src).into_iter().collect();
        assert!(
            registered.contains("keyring_available"),
            "scan sees the registration list"
        );
        assert!(
            registered.len() >= 15,
            "handler list has every command: {registered:?}"
        );

        let violations = contract_violations(&frontend, &registered);
        assert!(
            violations.is_empty(),
            "invoke ↔ handler contract broken:\n  {}",
            violations.join("\n  ")
        );
    }

    // Task 020 (global summon): the host registers the single-instance guard
    // and the global shortcut in the builder, records the registration
    // outcome so the status command can report it, and the command joins the
    // handler list — the UI says *why* the global path is missing instead of
    // silently falling back (020's "conflicts … saying so" clause).
    //
    // Needles are assembled at runtime so this test's own source cannot
    // satisfy them (the `command_is_async` trick).
    #[test]
    fn summon_hotkey_and_single_instance_are_wired_in_the_builder() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let lib_src = std::fs::read_to_string(dir.join("lib.rs")).expect("lib.rs is readable");
        let single = format!(".plugin(tauri_plugin_{}", "single_instance");
        let global = format!(".plugin(tauri_plugin_{}", "global_shortcut");
        let record = format!("{}::record(", "summon");
        assert!(
            lib_src.contains(&single),
            "single-instance plugin registered in the builder"
        );
        assert!(
            lib_src.contains(&global),
            "global-shortcut plugin registered in the builder"
        );
        assert!(
            lib_src.contains(&record),
            "setup records the registration outcome through summon::record"
        );
        let registered: BTreeSet<String> = registered_commands(&lib_src).into_iter().collect();
        assert!(
            registered.contains("summon_hotkey_status"),
            "status command in the handler list: {registered:?}"
        );
        let summon_src =
            std::fs::read_to_string(dir.join("summon.rs")).expect("summon.rs is readable");
        let cmd = format!("pub fn {}(", "summon_hotkey_status");
        assert!(
            summon_src.contains(&cmd),
            "status command implemented in summon.rs"
        );
    }

    /// The status command maps the *recorded* registration outcome: a
    /// registered shortcut resolves to the displayed combo, a conflict
    /// rejects with the host's reason, and an unfilled slot (a host that
    /// skipped setup) rejects too — the UI must never claim a global path
    /// that was not proven.
    #[test]
    fn summon_status_payload_carries_the_recorded_outcome() {
        assert_eq!(
            summon::status_payload(Some(Ok(()))).expect("registered"),
            summon::combo()
        );
        let err = summon::status_payload(Some(Err("hotkey in use".to_string())))
            .expect_err("conflict must reject");
        assert!(err.contains("hotkey in use"), "{err}");
        summon::status_payload(None).expect_err("never attempted must reject");
    }
}
