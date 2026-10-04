//! Clauro shell. The only crate that knows Tauri exists.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalogue;
mod keyring_store;
mod platform;

use tauri::Manager;

use catalogue::{
    is_fresh, read_cache, resolve, write_cache, Catalogue, CatalogueError, CATALOGUE_TTL_SECS,
};
use keyring_store::KeyringError;
use platform::WebviewStatus;

// ── keyring commands ───────────────────────────────────────────────────────

#[tauri::command]
fn keyring_store(account: String, secret: String) -> Result<(), KeyringError> {
    keyring_store::store(&account, &secret)
}

#[tauri::command]
fn keyring_retrieve(account: String) -> Result<String, KeyringError> {
    keyring_store::retrieve(&account)
}

#[tauri::command]
fn keyring_delete(account: String) -> Result<(), KeyringError> {
    keyring_store::delete(&account)
}

#[tauri::command]
fn keyring_available() -> Result<(), KeyringError> {
    keyring_store::is_available()
}

// ── catalogue commands ─────────────────────────────────────────────────────

/// `models.dev` source of truth (D23). Fetched at runtime, never bundled.
const MODELS_DEV_URL: &str = "https://models.dev/api.json";

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

#[tauri::command]
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
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| CatalogueError::Network {
            reason: format!("cannot read body: {e}"),
        })
}

// ── platform commands ──────────────────────────────────────────────────────

#[tauri::command]
fn webview_status() -> WebviewStatus {
    platform::webview_status()
}

#[allow(dead_code)]
fn _catalogue_types() -> Option<(Catalogue, CatalogueError)> {
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            keyring_store,
            keyring_retrieve,
            keyring_delete,
            keyring_available,
            catalogue_status,
            catalogue_refresh,
            webview_status
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
}
