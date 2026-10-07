//! Providers: configured endpoints with their own keys and model lists (003).
//!
//! The picker shows only configured providers' models — an unconfigured
//! provider has no row and cannot appear. Keys live in the keyring under the
//! provider id and never reach SQLite; model ids live in SQLite and never
//! need a key to read. models.dev stays as *limits enrichment only*, fetched
//! lazily, never at boot.
//!
//! Behaviour mirrored from the two references, implementation ours:
//! OpenCode gates its picker on connected providers with per-provider auth
//! (PORTED, attributed below); Open WebUI discovers models per configured
//! endpoint (MIRRORED behaviour, own words, own implementation — observation
//! only per docs/references/licensing-and-attribution.md, D103).

use clauro_store::{ProviderKind, ProviderModel, Store, StoreError};

/// A built-in provider definition. URLs are endpoint facts; names and
/// descriptions are ours (D39).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Builtin {
    pub id: &'static str,
    pub display_name: &'static str,
    pub kind: ProviderKind,
    /// Endpoint root for `openai_compatible`. `None` for Anthropic — fixed.
    pub base_url: Option<&'static str>,
}

/// Built-in providers, in picker order. Three first-class entries plus the
/// `custom` shape handled by `validate_base_url`/`validate_custom_id` — one
/// generic path covers every other OpenAI-compatible endpoint instead of N
/// curated rows that rot on vendor cadence.
pub fn builtins() -> Vec<Builtin> {
    vec![
        Builtin {
            id: "anthropic",
            display_name: "Anthropic",
            kind: ProviderKind::Anthropic,
            base_url: None,
        },
        Builtin {
            id: "openai",
            display_name: "OpenAI",
            kind: ProviderKind::OpenAiCompatible,
            base_url: Some("https://api.openai.com/v1"),
        },
        Builtin {
            id: "openrouter",
            display_name: "OpenRouter",
            kind: ProviderKind::OpenAiCompatible,
            base_url: Some("https://openrouter.ai/api/v1"),
        },
    ]
}

/// Look up a built-in by id. Custom ids are not builtins — they resolve from
/// the store row instead.
#[must_use]
pub fn builtin(id: &str) -> Option<Builtin> {
    builtins().into_iter().find(|b| b.id == id)
}

/// Validate a custom base URL. Only http(s) endpoints; no blanks, no
/// credentials smuggled in the URL, no trailing-slash ambiguity. Returns the
/// canonical root (no trailing slash) the fetchers append `/models` to.
pub fn validate_base_url(raw: &str) -> Result<String, ProviderError> {
    let bad = |reason: &str| ProviderError::BadInput {
        reason: reason.to_string(),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(bad("endpoint URL must not be blank"));
    }
    let root = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .ok_or_else(|| bad("endpoint must start with http:// or https://"))?;
    if root.is_empty() || root.contains(' ') || root.contains('@') {
        return Err(bad("endpoint is not a usable host"));
    }
    // A host without a dot is a typo (or an intranet name we refuse to
    // guess about) — except localhost, which is the local-model case.
    let host = root.split('/').next().unwrap_or("");
    let host_ok = host == "localhost"
        || host.starts_with("localhost:")
        || host.starts_with("127.0.0.1")
        || host.contains('.');
    if !host_ok {
        return Err(bad("endpoint host is not usable"));
    }
    let scheme = if trimmed.starts_with("https://") {
        "https://"
    } else {
        "http://"
    };
    Ok(format!("{scheme}{}", root.trim_end_matches('/')))
}

/// Validate a provider id for custom entries. Lowercase alphanumerics and
/// dashes: it becomes a keyring account and a store key downstream, so
/// anything else is a second credential namespace waiting to confuse.
/// Built-in ids are reserved — a custom entry must not shadow one.
pub fn validate_custom_id(raw: &str) -> Result<String, ProviderError> {
    let id = raw.trim().to_string();
    if id.is_empty() {
        return Err(ProviderError::BadInput {
            reason: "provider id must not be blank".to_string(),
        });
    }
    if builtin(&id).is_some() {
        return Err(ProviderError::BadInput {
            reason: format!("'{id}' is a built-in provider id"),
        });
    }
    let bad = |reason: &str| ProviderError::BadInput {
        reason: reason.to_string(),
    };
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        return Err(bad(
            "provider id must be lowercase letters, digits, and dashes",
        ));
    }
    Ok(id)
}

/// Freshness over an injected clock. `None` (never fetched) is always stale;
/// the clock is a parameter so tests never sleep.
#[must_use]
pub fn models_stale(fetched_at: Option<i64>, now_secs: u64, ttl_secs: i64) -> bool {
    match fetched_at {
        None => true,
        Some(t) => (now_secs as i64).saturating_sub(t) >= ttl_secs,
    }
}

/// Parse an Anthropic `/v1/models` body into `(id, display_name)` pairs.
/// Unknown fields ignored; entries without an id skipped, never invented.
pub fn parse_anthropic_models(body: &[u8]) -> Result<Vec<ProviderModel>, ProviderError> {
    #[derive(serde::Deserialize)]
    struct Entry {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        display_name: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Body {
        #[serde(default)]
        data: Vec<Entry>,
    }
    let parsed: Body = serde_json::from_slice(body).map_err(|e| ProviderError::Fetch {
        reason: format!("unreadable model list: {e}"),
    })?;
    Ok(parsed
        .data
        .into_iter()
        .filter_map(|e| {
            let id = e.id.filter(|s| !s.trim().is_empty())?;
            Some(ProviderModel {
                display_name: e
                    .display_name
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| id.clone()),
                id,
            })
        })
        .collect())
}

/// Parse an OpenAI-compatible `/v1/models` body into `(id, display_name)`
/// pairs. `name` doubles as the display name when present (OpenRouter sends
/// one); otherwise the id is shown as-is.
pub fn parse_openai_models(body: &[u8]) -> Result<Vec<ProviderModel>, ProviderError> {
    #[derive(serde::Deserialize)]
    struct Entry {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        name: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Body {
        #[serde(default)]
        data: Vec<Entry>,
    }
    let parsed: Body = serde_json::from_slice(body).map_err(|e| ProviderError::Fetch {
        reason: format!("unreadable model list: {e}"),
    })?;
    Ok(parsed
        .data
        .into_iter()
        .filter_map(|e| {
            let id = e.id.filter(|s| !s.trim().is_empty())?;
            Some(ProviderModel {
                display_name: e
                    .name
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| id.clone()),
                id,
            })
        })
        .collect())
}

/// Typed provider failure. No key material, ever — variants carry reasons.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ProviderError {
    BadInput { reason: String },
    NoKey { provider: String },
    UnknownProvider { provider: String },
    Fetch { reason: String },
    Store { reason: String },
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadInput { reason } => write!(f, "bad provider input: {reason}"),
            Self::NoKey { provider } => write!(
                f,
                "no API key for {provider} in the keychain; add one before refreshing"
            ),
            Self::UnknownProvider { provider } => write!(f, "no such provider: {provider}"),
            Self::Fetch { reason } => write!(f, "provider request failed: {reason}"),
            Self::Store { reason } => write!(f, "store error: {reason}"),
        }
    }
}

impl std::error::Error for ProviderError {}

pub fn map_store(e: StoreError) -> ProviderError {
    match e {
        StoreError::NotFound(reason) => ProviderError::UnknownProvider { provider: reason },
        other => ProviderError::Store {
            reason: other.to_string(),
        },
    }
}

/// Stored models for one provider, for the picker. No key needed to read —
/// ids are not secrets. An unconfigured provider is `UnknownProvider`, never
/// an empty list that looks configured.
pub fn read_models_for_picker(
    store: &Store,
    provider_id: &str,
) -> Result<Vec<ProviderModel>, ProviderError> {
    if store
        .get_provider(provider_id)
        .map_err(map_store)?
        .is_none()
    {
        return Err(ProviderError::UnknownProvider {
            provider: provider_id.to_string(),
        });
    }
    Ok(store
        .list_provider_models(provider_id)
        .map_err(map_store)?
        .into_iter()
        .map(|m| ProviderModel {
            id: m.id,
            display_name: m.display_name,
        })
        .collect())
}

// ── live fetchers ──────────────────────────────────────────────────────────

/// Anthropic's model-list endpoint. Fixed URL — the one URL besides the
/// messages endpoint the shell is allowed to know.
const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models";
/// Anthropic API version header, same pin as the turn driver.
const ANTHROPIC_VERSION: &str = "2023-06-01";

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn http_client() -> Result<reqwest::blocking::Client, ProviderError> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| ProviderError::Fetch {
            reason: format!("cannot build HTTP client: {e}"),
        })
}

/// Fetch + parse one provider's live model list. The key was just stored (or
/// just read) — this is the call that proves it works.
fn fetch_live_models(
    kind: ProviderKind,
    base_url: Option<&str>,
    key: &str,
) -> Result<Vec<ProviderModel>, ProviderError> {
    let client = http_client()?;
    let req = match kind {
        ProviderKind::Anthropic => client
            .get(ANTHROPIC_MODELS_URL)
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        ProviderKind::OpenAiCompatible => {
            let root = base_url.ok_or_else(|| ProviderError::BadInput {
                reason: "this provider has no endpoint URL".to_string(),
            })?;
            client.get(format!("{root}/models")).bearer_auth(key)
        }
    };
    let resp = req.send().map_err(|e| ProviderError::Fetch {
        reason: if e.is_connect() {
            "cannot reach the provider (connection failed)".to_string()
        } else if e.is_timeout() {
            "provider timed out".to_string()
        } else {
            format!("request failed: {e}")
        },
    })?;
    if !resp.status().is_success() {
        let detail: String = resp.text().unwrap_or_default().chars().take(300).collect();
        return Err(ProviderError::Fetch {
            reason: if detail.trim().is_empty() {
                "provider refused the key or the request".to_string()
            } else {
                format!("provider refused: {}", detail.trim())
            },
        });
    }
    let bytes = resp.bytes().map_err(|e| ProviderError::Fetch {
        reason: format!("cannot read model list: {e}"),
    })?;
    match kind {
        ProviderKind::Anthropic => parse_anthropic_models(&bytes),
        ProviderKind::OpenAiCompatible => parse_openai_models(&bytes),
    }
}

// ── command views ──────────────────────────────────────────────────────────

/// One provider as the settings surface renders it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ProviderView {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub base_url: Option<String>,
    pub model_count: usize,
    pub models_fetched_at: Option<i64>,
    /// True when the list is older than its TTL or was never fetched.
    pub stale: bool,
    /// True when the keyring holds a non-blank key for this provider.
    pub has_key: bool,
}

/// One provider's stored models with their freshness.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ModelsView {
    pub provider_id: String,
    pub models: Vec<ProviderModel>,
    pub models_fetched_at: Option<i64>,
    pub stale: bool,
}

fn has_key(id: &str) -> bool {
    crate::keyring_store::retrieve(id)
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

fn view_of(
    store: &Store,
    row: clauro_store::ProviderRow,
    now: u64,
) -> Result<ProviderView, ProviderError> {
    let count = store
        .list_provider_models(&row.id)
        .map_err(map_store)?
        .len();
    Ok(ProviderView {
        id: row.id.clone(),
        display_name: row.display_name,
        kind: row.kind.as_str().to_string(),
        base_url: row.base_url,
        model_count: count,
        models_fetched_at: row.models_fetched_at,
        stale: models_stale(row.models_fetched_at, now, row.models_ttl_secs),
        has_key: has_key(&row.id),
    })
}

/// Every configured provider. Unconfigured providers have no row and cannot
/// appear — the picker is gated on this list.
#[tauri::command]
pub fn provider_list(
    state: tauri::State<'_, crate::turn::TurnState>,
) -> Result<Vec<ProviderView>, ProviderError> {
    let store = state.store.lock().map_err(|_| ProviderError::Store {
        reason: "store lock poisoned".to_string(),
    })?;
    let now = now_secs();
    store
        .list_providers()
        .map_err(map_store)?
        .into_iter()
        .map(|row| view_of(&store, row, now))
        .collect()
}

/// Add a built-in provider by id. Models are NOT fetched here — the provider
/// has no key yet, and an unauthenticated fetch would fail loudly for no
/// reason. `provider_set_key` performs the first fetch.
#[tauri::command]
pub fn provider_add_builtin(
    state: tauri::State<'_, crate::turn::TurnState>,
    id: String,
) -> Result<ProviderView, ProviderError> {
    let def = builtin(id.trim()).ok_or_else(|| ProviderError::BadInput {
        reason: format!("'{id}' is not a built-in provider id"),
    })?;
    let store = state.store.lock().map_err(|_| ProviderError::Store {
        reason: "store lock poisoned".to_string(),
    })?;
    store
        .insert_provider(clauro_store::NewProvider {
            id: def.id.to_string(),
            kind: def.kind,
            display_name: def.display_name.to_string(),
            base_url: def.base_url.map(str::to_string),
            added_at: now_secs() as i64,
        })
        .map_err(|e| match e {
            StoreError::Sqlite(_) => ProviderError::BadInput {
                reason: format!("provider '{id}' is already added"),
            },
            other => map_store(other),
        })?;
    let row = store
        .get_provider(def.id)
        .map_err(map_store)?
        .ok_or_else(|| ProviderError::Store {
            reason: "provider vanished after insert".to_string(),
        })?;
    view_of(&store, row, now_secs())
}

/// Add a custom OpenAI-compatible provider. The URL is validated structurally
/// here; the key (and the live proof) arrives with `provider_set_key`.
#[tauri::command]
pub fn provider_add_custom(
    state: tauri::State<'_, crate::turn::TurnState>,
    id: String,
    display_name: String,
    base_url: String,
) -> Result<ProviderView, ProviderError> {
    let id = validate_custom_id(&id)?;
    let url = validate_base_url(&base_url)?;
    let name = display_name.trim();
    if name.is_empty() {
        return Err(ProviderError::BadInput {
            reason: "display name must not be blank".to_string(),
        });
    }
    let store = state.store.lock().map_err(|_| ProviderError::Store {
        reason: "store lock poisoned".to_string(),
    })?;
    store
        .insert_provider(clauro_store::NewProvider {
            id: id.clone(),
            kind: ProviderKind::OpenAiCompatible,
            display_name: name.to_string(),
            base_url: Some(url),
            added_at: now_secs() as i64,
        })
        .map_err(|e| match e {
            StoreError::Sqlite(_) => ProviderError::BadInput {
                reason: format!("provider '{id}' is already added"),
            },
            other => map_store(other),
        })?;
    let row = store
        .get_provider(&id)
        .map_err(map_store)?
        .ok_or_else(|| ProviderError::Store {
            reason: "provider vanished after insert".to_string(),
        })?;
    view_of(&store, row, now_secs())
}

/// Remove a provider, its models, and its key. Key first, then rows: a failure
/// afterwards leaves no orphaned secret, only a keyless row the user can
/// remove again. Removing twice is a no-op returning false.
#[tauri::command]
pub fn provider_remove(
    state: tauri::State<'_, crate::turn::TurnState>,
    id: String,
) -> Result<bool, ProviderError> {
    // Keyring delete is idempotent in this crate: missing entries are Ok.
    let _ = crate::keyring_store::delete(&id);
    let store = state.store.lock().map_err(|_| ProviderError::Store {
        reason: "store lock poisoned".to_string(),
    })?;
    store.remove_provider(&id).map_err(map_store)
}

/// Store a provider key and prove it: the key is validated by fetching the
/// live model list, which is stored on success. On failure the key is rolled
/// back out of the keychain and nothing is stored — a typo'd key fails here,
/// loudly, not at the first turn.
#[tauri::command]
pub fn provider_set_key(
    state: tauri::State<'_, crate::turn::TurnState>,
    id: String,
    key: String,
) -> Result<ModelsView, ProviderError> {
    if key.trim().is_empty() {
        return Err(ProviderError::BadInput {
            reason: "key must not be blank".to_string(),
        });
    }
    let (kind, base_url) = {
        let store = state.store.lock().map_err(|_| ProviderError::Store {
            reason: "store lock poisoned".to_string(),
        })?;
        let row = store.get_provider(&id).map_err(map_store)?.ok_or_else(|| {
            ProviderError::UnknownProvider {
                provider: id.clone(),
            }
        })?;
        (row.kind, row.base_url.clone())
    };
    crate::keyring_store::store(&id, key.trim()).map_err(|_| ProviderError::Store {
        reason: "cannot write the keychain".to_string(),
    })?;
    let models = match fetch_live_models(kind, base_url.as_deref(), key.trim()) {
        Ok(m) => m,
        Err(e) => {
            // Roll back: a key that never validated must not linger.
            let _ = crate::keyring_store::delete(&id);
            return Err(e);
        }
    };
    let now = now_secs() as i64;
    {
        let store = state.store.lock().map_err(|_| ProviderError::Store {
            reason: "store lock poisoned".to_string(),
        })?;
        store
            .replace_provider_models(&id, &models, now)
            .map_err(map_store)?;
        let row =
            store
                .get_provider(&id)
                .map_err(map_store)?
                .ok_or_else(|| ProviderError::Store {
                    reason: "provider vanished after fetch".to_string(),
                })?;
        Ok(ModelsView {
            provider_id: id,
            models,
            models_fetched_at: row.models_fetched_at,
            stale: false,
        })
    }
}

/// One stored model joined with its limits, when the enrichment knows them.
/// Limits come from models.dev; a model it never heard of (typical for custom
/// endpoints) carries `limits_known: false` and the picker refuses selection
/// rather than zero-guessing (CONTRACTS.md §5). Custom-model limits arrive
/// with the live-turn translator, which needs them for the request anyway.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct EnrichedModel {
    pub id: String,
    pub display_name: String,
    pub limits_known: bool,
    pub context_window: Option<u64>,
    pub max_output: Option<u64>,
    pub reasoning: bool,
    pub tool_call: bool,
}

/// Read the enrichment cache, fetching it first when absent or older than its
/// TTL. A failed fetch is NOT an error here — it yields `None`, and every
/// model degrades to `limits_known: false`. Enrichment is a background fact,
/// never a picker blocker. The boot path never calls this; it runs on first
/// provider-models read instead.
fn enrichment_catalogue(data_dir: &std::path::Path) -> Option<crate::catalogue::Catalogue> {
    use crate::catalogue::{is_fresh, read_cache, write_cache, ENRICHMENT_TTL_SECS};
    let now = now_secs();
    let fresh_enough = read_cache(data_dir)
        .ok()
        .flatten()
        .filter(|c| is_fresh(c.modified_secs, now, ENRICHMENT_TTL_SECS))
        .map(|c| c.bytes);
    if let Some(bytes) = fresh_enough {
        return crate::catalogue::parse_catalogue(&bytes).ok();
    }
    // Absent or stale: one blocking fetch. The caller is already a command;
    // slow enrichment delays the picker once per week, not once per boot.
    let bytes = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .ok()?
        .get(crate::catalogue::MODELS_DEV_URL)
        .send()
        .ok()?
        .bytes()
        .ok()?
        .to_vec();
    // A failed cache write must not fail enrichment: memory serves this read.
    let _ = write_cache(data_dir, &bytes);
    crate::catalogue::parse_catalogue(&bytes).ok()
}

/// Stored models for one provider joined with enrichment. One invoke per
/// provider: the picker renders limits (or their honest absence) without N
/// round-trips.
#[tauri::command]
pub fn provider_models_enriched(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::turn::TurnState>,
    id: String,
) -> Result<Vec<EnrichedModel>, ProviderError> {
    use tauri::Manager as _;
    let (stored, provider_id) = {
        let store = state.store.lock().map_err(|_| ProviderError::Store {
            reason: "store lock poisoned".to_string(),
        })?;
        let row = store.get_provider(&id).map_err(map_store)?.ok_or_else(|| {
            ProviderError::UnknownProvider {
                provider: id.clone(),
            }
        })?;
        let models = read_models_for_picker(&store, &row.id)?;
        (models, row.id)
    };
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| ProviderError::Store {
            reason: format!("no app-data dir: {e}"),
        })?;
    let enrichment = enrichment_catalogue(&data_dir);
    Ok(join_enrichment(&provider_id, stored, enrichment.as_ref()))
}

/// Join stored models with enrichment. Pure: the network half lives in
/// `enrichment_catalogue`, so this — the degradation rule — is fully testable
/// without a socket.
fn join_enrichment(
    provider_id: &str,
    stored: Vec<ProviderModel>,
    enrichment: Option<&crate::catalogue::Catalogue>,
) -> Vec<EnrichedModel> {
    stored
        .into_iter()
        .map(|m| {
            let hit = enrichment.and_then(|c| c.find(provider_id, &m.id));
            match hit {
                Some(limits) => EnrichedModel {
                    id: m.id,
                    display_name: m.display_name,
                    limits_known: true,
                    context_window: Some(limits.context_window),
                    max_output: Some(limits.max_output),
                    reasoning: limits.reasoning,
                    tool_call: limits.tool_call,
                },
                None => EnrichedModel {
                    id: m.id,
                    display_name: m.display_name,
                    limits_known: false,
                    context_window: None,
                    max_output: None,
                    reasoning: false,
                    tool_call: false,
                },
            }
        })
        .collect()
}

/// Stored models for one provider, with freshness. No key needed to read —
/// ids are not secrets. Stale lists are returned as-is with `stale: true`;
/// the UI offers refresh (`provider_refresh`) rather than blocking the picker
/// on a network call.
#[tauri::command]
pub fn provider_models(
    state: tauri::State<'_, crate::turn::TurnState>,
    id: String,
) -> Result<ModelsView, ProviderError> {
    let store = state.store.lock().map_err(|_| ProviderError::Store {
        reason: "store lock poisoned".to_string(),
    })?;
    let row = store.get_provider(&id).map_err(map_store)?.ok_or_else(|| {
        ProviderError::UnknownProvider {
            provider: id.clone(),
        }
    })?;
    let models = read_models_for_picker(&store, &id)?;
    Ok(ModelsView {
        provider_id: id,
        models,
        models_fetched_at: row.models_fetched_at,
        stale: models_stale(row.models_fetched_at, now_secs(), row.models_ttl_secs),
    })
}

/// Re-fetch one provider's live model list. Needs the stored key — a
/// keyless provider fails `NoKey`, which is the UI's cue to ask for one.
#[tauri::command]
pub fn provider_refresh(
    state: tauri::State<'_, crate::turn::TurnState>,
    id: String,
) -> Result<ModelsView, ProviderError> {
    let (kind, base_url) = {
        let store = state.store.lock().map_err(|_| ProviderError::Store {
            reason: "store lock poisoned".to_string(),
        })?;
        let row = store.get_provider(&id).map_err(map_store)?.ok_or_else(|| {
            ProviderError::UnknownProvider {
                provider: id.clone(),
            }
        })?;
        (row.kind, row.base_url.clone())
    };
    let key = crate::keyring_store::retrieve(&id).map_err(|_| ProviderError::NoKey {
        provider: id.clone(),
    })?;
    if key.trim().is_empty() {
        return Err(ProviderError::NoKey {
            provider: id.clone(),
        });
    }
    let models = fetch_live_models(kind, base_url.as_deref(), key.trim())?;
    let now = now_secs() as i64;
    let store = state.store.lock().map_err(|_| ProviderError::Store {
        reason: "store lock poisoned".to_string(),
    })?;
    store
        .replace_provider_models(&id, &models, now)
        .map_err(map_store)?;
    Ok(ModelsView {
        provider_id: id,
        models,
        models_fetched_at: Some(now),
        stale: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_cover_the_three_first_class_providers() {
        let ids: Vec<&str> = builtins().iter().map(|b| b.id).collect();
        assert_eq!(ids, vec!["anthropic", "openai", "openrouter"]);
    }

    #[test]
    fn anthropic_has_no_configurable_url() {
        let a = builtins()
            .into_iter()
            .find(|b| b.id == "anthropic")
            .expect("anthropic");
        assert_eq!(a.kind, ProviderKind::Anthropic);
        assert_eq!(a.base_url, None);
    }

    #[test]
    fn compat_providers_carry_their_roots() {
        for id in ["openai", "openrouter"] {
            let b = builtins().into_iter().find(|b| b.id == id).expect(id);
            assert_eq!(b.kind, ProviderKind::OpenAiCompatible);
            let url = b.base_url.expect("compat has a root");
            assert!(
                url.starts_with("https://"),
                "{id} root must be https: {url}"
            );
        }
    }

    #[test]
    fn base_url_accepts_a_clean_https_root() {
        assert_eq!(
            validate_base_url("https://llm.office.example/v1/").expect("valid"),
            "https://llm.office.example/v1"
        );
    }

    #[test]
    fn base_url_rejects_garbage() {
        for bad in ["", "   ", "not-a-url", "ftp://x.example", "https://"] {
            assert!(
                validate_base_url(bad).is_err(),
                "{bad:?} must not become an endpoint"
            );
        }
    }

    #[test]
    fn custom_id_accepts_lowercase_dashes() {
        assert_eq!(
            validate_custom_id("office-gateway").expect("valid"),
            "office-gateway"
        );
    }

    #[test]
    fn custom_id_rejects_anything_else() {
        for bad in ["", "Office", "has space", "under_score", "anthropic"] {
            assert!(
                validate_custom_id(bad).is_err(),
                "{bad:?} must not become a provider id"
            );
        }
    }

    #[test]
    fn never_fetched_is_always_stale() {
        assert!(models_stale(None, 1_000_000, 259_200));
    }

    #[test]
    fn freshness_follows_the_ttl() {
        assert!(!models_stale(Some(1_000_000), 1_100_000, 259_200));
        assert!(models_stale(Some(1_000_000), 1_300_000, 259_200));
    }

    #[test]
    fn anthropic_models_parse_ids_and_names() {
        let body = br#"{"data": [
            {"type": "model", "id": "claude-x", "display_name": "Claude X"},
            {"type": "model", "id": "claude-y", "display_name": "Claude Y"}
        ]}"#;
        let out = parse_anthropic_models(body).expect("parse");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "claude-x");
        assert_eq!(out[0].display_name, "Claude X");
    }

    #[test]
    fn anthropic_entries_without_ids_are_skipped() {
        let body = br#"{"data": [{"type": "model", "display_name": "Nameless"}]}"#;
        assert!(parse_anthropic_models(body).expect("parse").is_empty());
    }

    #[test]
    fn openai_models_parse_ids() {
        let body = br#"{"object": "list", "data": [
            {"id": "gpt-x", "object": "model", "owned_by": "org"},
            {"id": "gpt-y", "object": "model", "owned_by": "org"}
        ]}"#;
        let out = parse_openai_models(body).expect("parse");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "gpt-x");
    }

    #[test]
    fn openrouter_names_become_display_names() {
        let body = br#"{"data": [
            {"id": "vendor/model-x", "name": "Model X", "context_length": 128000}
        ]}"#;
        let out = parse_openai_models(body).expect("parse");
        assert_eq!(out[0].display_name, "Model X");
    }

    #[test]
    fn garbage_bodies_fail_typed_never_panic() {
        assert!(parse_anthropic_models(b"not json").is_err());
        assert!(parse_openai_models(b"{\"data\": \"nope\"}").is_err());
    }

    #[test]
    fn picker_reads_stored_models_without_a_key() {
        let store = Store::open_memory().expect("store");
        store
            .insert_provider(clauro_store::NewProvider {
                id: "anthropic".to_string(),
                kind: ProviderKind::Anthropic,
                display_name: "Anthropic".to_string(),
                base_url: None,
                added_at: 100,
            })
            .expect("insert");
        store
            .replace_provider_models(
                "anthropic",
                &[ProviderModel {
                    id: "claude-x".to_string(),
                    display_name: "Claude X".to_string(),
                }],
                1_000,
            )
            .expect("models");
        let out = read_models_for_picker(&store, "anthropic").expect("read");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "claude-x");
    }

    #[test]
    fn enrichment_hit_marks_limits_known() {
        use crate::catalogue::{Catalogue, CatalogueModel};
        let mut enrichment = Catalogue::default();
        enrichment.providers.insert(
            "anthropic".to_string(),
            vec![CatalogueModel {
                id: "claude-x".to_string(),
                name: "Claude X".to_string(),
                context_window: 200_000,
                max_output: 8_192,
                reasoning: true,
                tool_call: true,
            }],
        );
        let out = join_enrichment(
            "anthropic",
            vec![ProviderModel {
                id: "claude-x".to_string(),
                display_name: "Claude X".to_string(),
            }],
            Some(&enrichment),
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].limits_known);
        assert_eq!(out[0].context_window, Some(200_000));
    }

    #[test]
    fn enrichment_miss_degrades_visibly_never_zero_guessed() {
        // A custom-endpoint model the enrichment never heard of: no limits,
        // explicitly flagged — never a fabricated zero or a silent default.
        let out = join_enrichment(
            "office-gateway",
            vec![ProviderModel {
                id: "mystery-1".to_string(),
                display_name: "Mystery 1".to_string(),
            }],
            None,
        );
        assert!(!out[0].limits_known);
        assert_eq!(out[0].context_window, None);
        assert_eq!(out[0].max_output, None);
    }

    #[test]
    fn picker_read_for_unknown_provider_fails_typed() {
        let store = Store::open_memory().expect("store");
        assert!(matches!(
            read_models_for_picker(&store, "ghost"),
            Err(ProviderError::UnknownProvider { .. })
        ));
    }
}
