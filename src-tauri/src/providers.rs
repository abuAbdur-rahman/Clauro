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

use std::sync::Arc;

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

/// Built-in providers, in picker order. Four first-class entries plus the
/// `custom` shape handled by `validate_base_url`/`validate_custom_id` — one
/// generic path covers every other OpenAI-compatible endpoint instead of N
/// curated rows that rot on vendor cadence (D125).
pub fn builtins() -> Vec<Builtin> {
    vec![
        Builtin {
            id: "openrouter",
            display_name: "OpenRouter",
            kind: ProviderKind::OpenAiCompatible,
            base_url: Some("https://openrouter.ai/api/v1"),
        },
        Builtin {
            id: "agentrouter",
            display_name: "AgentRouter",
            kind: ProviderKind::OpenAiCompatible,
            base_url: Some("https://agentrouter.org/v1"),
        },
        Builtin {
            id: "ollama",
            display_name: "Ollama (local)",
            kind: ProviderKind::OpenAiCompatible,
            base_url: Some("http://localhost:11434/v1"),
        },
        Builtin {
            id: "google",
            display_name: "Google",
            kind: ProviderKind::OpenAiCompatible,
            base_url: Some("https://generativelanguage.googleapis.com/v1beta/openai"),
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
/// credentials smuggled in the URL, no trailing-slash ambiguity. Cleartext
/// is accepted only for loopback — the local-model case (Ollama) and the dev
/// mock (`pnpm mock` on 127.0.0.1:8787) never leave this machine; every
/// remote endpoint must be https, or the next turn would hand the provider's
/// bearer token to the network in cleartext (review 13, item 5). Returns the
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
    // The authority without its port, and without IPv6 brackets:
    // `127.0.0.1:8787` → `127.0.0.1`, `[::1]:11434` → `::1`. Stripping the
    // port first is what makes the host checks exact — a prefix match would
    // welcome `127.0.0.1.attacker.example` as if it were loopback.
    let authority = root.split('/').next().unwrap_or("");
    let host = if let Some(inner) = authority.strip_prefix('[') {
        inner.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    // A host without a dot is a typo (or an intranet name we refuse to
    // guess about) — except loopback, the local-model case.
    if !is_loopback_host(host) && !host.contains('.') {
        return Err(bad("endpoint host is not usable"));
    }
    if trimmed.starts_with("http://") && !is_loopback_host(host) {
        return Err(bad(
            "endpoint must use https:// — cleartext http:// is only allowed for loopback endpoints (localhost, 127.0.0.1, [::1])",
        ));
    }
    let scheme = if trimmed.starts_with("https://") {
        "https://"
    } else {
        "http://"
    };
    Ok(format!("{scheme}{}", root.trim_end_matches('/')))
}

/// The only hosts cleartext is allowed for: loopback, in the spellings a
/// user can type plus the inner form of a bracketed IPv6 literal.
fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Bound a provider-controlled error body and never let the provider key
/// ride along: a proxy can echo our own Authorization header back into the
/// error page, and this text lands in a persisted error (review 13 NIT).
/// Redact first, then truncate — truncating first could cut the key and
/// leave a recognisable fragment behind.
pub(crate) fn sanitise_provider_detail(detail: &str, secret: &str) -> String {
    let secret = secret.trim();
    let replaced = if secret.is_empty() {
        detail.to_string()
    } else {
        detail.replace(secret, "[redacted]")
    };
    replaced.chars().take(512).collect()
}

/// A keyring rollback that itself failed must not hide behind the original
/// error: the user needs to know the key is still in the keychain (review 13
/// NIT — a silently swallowed delete leaves a secret outliving its row).
pub(crate) fn combine_with_rollback(
    rollback: Result<(), String>,
    primary: ProviderError,
) -> ProviderError {
    match rollback {
        Ok(()) => primary,
        Err(delete_err) => ProviderError::Store {
            reason: format!(
                "{primary}; the key also could not be removed from the keychain: {delete_err}"
            ),
        },
    }
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

/// Whether a provider row accepts a blank key. Only the local-model case —
/// Ollama serves loopback with no key — every keyed endpoint still rejects
/// blanks loudly at set/refresh/turn time (D125).
#[must_use]
pub fn allows_blank_key(id: &str) -> bool {
    id.trim() == "ollama"
}

/// Whether a blank `key` must be refused for this row — the condition every
/// blank-key gate stands behind (`provider_set_key`, `provider_refresh`, the
/// turn/resume starts in `turn.rs`), extracted so the rule is one testable
/// seam instead of four inline copies (review 33): a blank is refused for
/// every row that is not keyless-capable (D125).
#[must_use]
pub(crate) fn blank_key_rejected(id: &str, key: &str) -> bool {
    key.trim().is_empty() && !allows_blank_key(id)
}

/// The bearer value for a key, or `None` when blank. A blank key must omit
/// the header, never send `Bearer ` or `Bearer null`.
#[must_use]
pub(crate) fn auth_header(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(format!("Bearer {trimmed}"))
    }
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
            let req = client.get(format!("{root}/models"));
            match auth_header(key) {
                Some(value) => req.header("authorization", value),
                None => req,
            }
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
        let detail = sanitise_provider_detail(&resp.text().unwrap_or_default(), key);
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn provider_remove(
    state: tauri::State<'_, crate::turn::TurnState>,
    id: String,
) -> Result<bool, ProviderError> {
    // Key first, then rows: a failure afterwards leaves no orphaned secret,
    // only a keyless row the user can remove again. A keychain failure is
    // reported, never swallowed — a secret must not outlive its row silently
    // (review 13 NIT). Delete is idempotent in this crate: missing entries
    // are Ok.
    crate::keyring_store::delete(&id).map_err(|e| ProviderError::Store {
        reason: format!("cannot remove the key from the keychain: {e}"),
    })?;
    let store = state.store.lock().map_err(|_| ProviderError::Store {
        reason: "store lock poisoned".to_string(),
    })?;
    store.remove_provider(&id).map_err(map_store)
}

/// Store a provider key and prove it: the key is validated by fetching the
/// live model list, which is stored on success. On failure the key is rolled
/// back out of the keychain and nothing is stored — a typo'd key fails here,
/// loudly, not at the first turn. The `ollama` row accepts a blank key: the
/// local server has none, and the proof fetch runs without auth.
///
/// `async fn` with the fetch on the blocking pool: the proof is up to 30 s
/// of network, and an `async` command body runs on a runtime worker — a
/// worker blocked that long delays every other command (review 13 FYI).
#[tauri::command]
pub async fn provider_set_key(
    state: tauri::State<'_, crate::turn::TurnState>,
    id: String,
    key: String,
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
    if blank_key_rejected(&id, &key) {
        return Err(ProviderError::BadInput {
            reason: "key must not be blank".to_string(),
        });
    }
    crate::keyring_store::store(&id, key.trim()).map_err(|_| ProviderError::Store {
        reason: "cannot write the keychain".to_string(),
    })?;
    // One typed path for both failures — the task never ran, or the provider
    // refused the key — so the rollback below covers every case.
    let proof: Result<Vec<ProviderModel>, ProviderError> =
        tauri::async_runtime::spawn_blocking(move || {
            fetch_live_models(kind, base_url.as_deref(), key.trim())
        })
        .await
        .map_err(|e| ProviderError::Store {
            reason: format!("model list task failed: {e}"),
        })
        .and_then(|inner| inner);
    let models = match proof {
        Ok(models) => models,
        Err(e) => {
            // Roll back: a key that never validated must not linger. A
            // failed rollback is reported alongside the original failure —
            // swallowing it would leave a secret with no owner (review 13
            // NIT).
            return Err(combine_with_rollback(
                crate::keyring_store::delete(&id).map_err(|e| e.to_string()),
                e,
            ));
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

/// Read the enrichment cache, answering from stale data while the refresh
/// runs behind the response, and fetching only when there is nothing to
/// answer with at all. A failed fetch is NOT an error here — it yields
/// `None`, and every model degrades to `limits_known: false`. Enrichment is
/// a background fact, never a picker blocker.
///
/// Runs on the blocking pool (the command spawns it there), never on the
/// WebView2 IPC thread and never on a runtime worker: a cold cache is a
/// 5.3 MB download with a 60 s ceiling, and a memo miss parses those same
/// 5.3 MB (A-perf-ipc).
fn enrichment_catalogue(
    data_dir: &std::path::Path,
    memo: &crate::catalogue::EnrichmentMemo,
) -> Option<Arc<crate::catalogue::Catalogue>> {
    use crate::catalogue::{load_enrichment, EnrichmentAction};
    let load = load_enrichment(data_dir, memo, now_secs(), crate::catalogue::read_cache);
    if load.action != EnrichmentAction::FetchNow {
        return settle_enrichment(load, data_dir, memo);
    }
    // Nothing usable: fetch now — but only one caller at a time. The second
    // picker's invoke waits on this lock and then answers from the memo the
    // first one filled, instead of downloading 5.3 MB twice.
    let _fetching = memo.fetch_guard();
    let again = load_enrichment(data_dir, memo, now_secs(), crate::catalogue::read_cache);
    if again.action == EnrichmentAction::FetchNow {
        let bytes = fetch_enrichment_blocking()?;
        return crate::catalogue::store_fetched(data_dir, memo, &bytes);
    }
    settle_enrichment(again, data_dir, memo)
}

/// Hand back the data and, when it is stale, start the refresh that must not
/// sit in the response path.
fn settle_enrichment(
    load: crate::catalogue::EnrichmentLoad,
    data_dir: &std::path::Path,
    memo: &crate::catalogue::EnrichmentMemo,
) -> Option<Arc<crate::catalogue::Catalogue>> {
    if load.action == crate::catalogue::EnrichmentAction::RefreshInBackground {
        spawn_refresh(data_dir.to_path_buf(), memo.clone());
    }
    load.catalogue
}

/// Fetch models.dev on the blocking pool: 5.3 MB with a 60 s ceiling, and
/// bounded like every other read of this URL (review 13 NIT). `None` is the
/// honest degradation — no network, no limits, never a panic.
fn fetch_enrichment_blocking() -> Option<Vec<u8>> {
    use crate::catalogue::{MAX_CACHE_BYTES, MODELS_DEV_URL};
    let bytes = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .ok()?
        .get(MODELS_DEV_URL)
        .send()
        .ok()?
        .bytes()
        .ok()?;
    if bytes.len() as u64 > MAX_CACHE_BYTES {
        return None;
    }
    Some(bytes.to_vec())
}

/// One refresh: fetch, write, memoise. Holds the fetch lock for its whole
/// duration so it can never collide with a cold-cache fetch's write.
fn refresh_enrichment(data_dir: &std::path::Path, memo: &crate::catalogue::EnrichmentMemo) {
    let _fetching = memo.fetch_guard();
    if let Some(bytes) = fetch_enrichment_blocking() {
        // No caller waits on this result: the memo inside `store_fetched` is
        // the delivery mechanism, so there is nothing to hand back.
        let _ = crate::catalogue::store_fetched(data_dir, memo, &bytes);
    }
}

/// Start at most one background refresh, off every request path: the caller
/// already answered from stale data, and this replaces it behind the
/// response instead of holding the invoke open for up to 60 s.
fn spawn_refresh(data_dir: std::path::PathBuf, memo: crate::catalogue::EnrichmentMemo) {
    if !memo.try_begin_refresh() {
        return; // one is already running; it will pick up the new file
    }
    let claimed = memo.clone();
    let thread_dir = data_dir.clone();
    let spawned = std::thread::Builder::new()
        .name("clauro-enrichment-refresh".to_string())
        .spawn(move || {
            // The guard's Drop clears the claim, panic or not.
            let _refreshing = claimed.refreshing_guard();
            refresh_enrichment(&thread_dir, &claimed);
        });
    if let Err(_spawn_err) = spawned {
        // No thread available: run it here instead of dropping the refresh.
        // The caller is already on the blocking pool, so the stall is
        // bounded and never reaches the UI thread.
        let _refreshing = memo.refreshing_guard();
        refresh_enrichment(&data_dir, &memo);
    }
}

/// Stored models for one provider joined with enrichment. One invoke per
/// provider: the picker renders limits (or their honest absence) without N
/// round-trips.
///
/// `async fn`: this is the boot path — two ModelPickers mount and each
/// invokes it per configured provider, so its body must never run on the
/// WebView2 IPC thread (tauri-macros runs a sync command inline there).
/// The enrichment half is heavier still and moves to the blocking pool.
#[tauri::command]
pub async fn provider_models_enriched(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::turn::TurnState>,
    memo: tauri::State<'_, crate::catalogue::EnrichmentMemo>,
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
    // Blocking pool, not the runtime worker an `async fn` body runs on: a
    // cold cache is a 60 s fetch and a memo miss is a 5.3 MB parse. The memo
    // turns every later invoke into a stat (A-perf-ipc).
    let memo = memo.inner().clone();
    let enrichment =
        tauri::async_runtime::spawn_blocking(move || enrichment_catalogue(&data_dir, &memo))
            .await
            .map_err(|e| ProviderError::Store {
                reason: format!("enrichment task failed: {e}"),
            })?;
    Ok(join_enrichment(&provider_id, stored, enrichment.as_deref()))
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
#[tauri::command(async)]
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
/// The `ollama` row is exempt: keyless by design, refreshed without auth.
///
/// `async fn` with the fetch on the blocking pool: up to 30 s of network
/// may not hold a runtime worker or the IPC thread (review 13 FYI).
#[tauri::command]
pub async fn provider_refresh(
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
    if blank_key_rejected(&id, &key) {
        return Err(ProviderError::NoKey {
            provider: id.clone(),
        });
    }
    let models: Vec<ProviderModel> = tauri::async_runtime::spawn_blocking(move || {
        fetch_live_models(kind, base_url.as_deref(), key.trim())
    })
    .await
    .map_err(|e| ProviderError::Store {
        reason: format!("model list task failed: {e}"),
    })??;
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
    fn four_builtins_plus_custom_are_the_five_first_class_providers() {
        let ids: Vec<&str> = builtins().iter().map(|b| b.id).collect();
        assert_eq!(ids, vec!["openrouter", "agentrouter", "ollama", "google"]);
    }

    #[test]
    fn ollama_root_is_loopback_v1() {
        let o = builtins()
            .into_iter()
            .find(|b| b.id == "ollama")
            .expect("ollama");
        assert_eq!(o.kind, ProviderKind::OpenAiCompatible);
        assert_eq!(o.base_url, Some("http://localhost:11434/v1"));
    }

    #[test]
    fn compat_providers_carry_their_roots() {
        for id in ["openrouter", "agentrouter", "google"] {
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
    fn agentrouter_root_is_the_openai_compatible_base() {
        let b = builtins()
            .into_iter()
            .find(|b| b.id == "agentrouter")
            .expect("agentrouter");
        assert_eq!(b.base_url, Some("https://agentrouter.org/v1"));
    }

    #[test]
    fn google_root_is_the_openai_compatibility_base() {
        let b = builtins()
            .into_iter()
            .find(|b| b.id == "google")
            .expect("google");
        assert_eq!(
            b.base_url,
            Some("https://generativelanguage.googleapis.com/v1beta/openai")
        );
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
    fn cleartext_is_allowed_only_for_loopback_endpoints() {
        // https is fine anywhere.
        assert!(validate_base_url("https://llm.example/v1").is_ok());
        // Loopback cleartext keeps working: the dev mock (`pnpm mock` on
        // 127.0.0.1:8787) and local models (Ollama on localhost) never leave
        // this machine, so the key cannot leak to the network.
        assert_eq!(
            validate_base_url("http://127.0.0.1:8787/v1").expect("loopback ipv4"),
            "http://127.0.0.1:8787/v1"
        );
        assert_eq!(
            validate_base_url("http://localhost:11434/v1").expect("localhost"),
            "http://localhost:11434/v1"
        );
        assert_eq!(
            validate_base_url("http://[::1]:11434/v1").expect("loopback ipv6"),
            "http://[::1]:11434/v1"
        );
        // Remote cleartext is refused typed: a keyed endpoint over cleartext
        // hands the bearer token to the network (review 13, item 5).
        for bad in [
            "http://attacker.example/v1",
            // A loopback-looking host is not loopback.
            "http://127.0.0.1.attacker.example/v1",
            "http://localhost.attacker.example/v1",
            "http://127.0.0.1evil/v1",
        ] {
            let err = validate_base_url(bad).expect_err("must refuse");
            assert!(
                matches!(err, ProviderError::BadInput { .. }),
                "{bad:?}: {err:?}"
            );
            if let ProviderError::BadInput { reason } = &err {
                assert!(
                    reason.contains("https://"),
                    "{bad:?} reason should point at https: {reason}"
                );
            }
        }
    }

    #[test]
    fn every_builtin_endpoint_survives_validation() {
        for b in builtins() {
            if let Some(url) = b.base_url {
                assert_eq!(
                    validate_base_url(url).expect(b.id),
                    url,
                    "builtin {id} must keep its shipped endpoint",
                    id = b.id
                );
            }
        }
    }

    #[test]
    fn error_details_are_truncated_and_the_key_never_persists() {
        let key = "sk-live-secret";
        let echo = format!(
            "proxy echoed: authorization: Bearer {key}\n{}",
            "x".repeat(4_000)
        );
        let out = sanitise_provider_detail(&echo, key);
        assert!(!out.contains(key), "the key must never persist: {out}");
        assert!(out.contains("[redacted]"), "{out}");
        assert!(out.chars().count() <= 512, "bounded: {}", out.len());
        // A blank secret redacts nothing but the bound still applies.
        let out = sanitise_provider_detail(&echo, "");
        assert!(out.chars().count() <= 512);
    }

    #[test]
    fn a_failed_keyring_rollback_is_reported_not_swallowed() {
        let primary = ProviderError::Fetch {
            reason: "model list fetch failed".to_string(),
        };
        // A clean rollback reports the original failure unchanged.
        assert_eq!(combine_with_rollback(Ok(()), primary.clone()), primary);
        // A failed rollback names both: the key is still in the keychain
        // and the user must be told (review 13 NIT).
        let combined = combine_with_rollback(
            Err("access denied".to_string()),
            ProviderError::Fetch {
                reason: "model list fetch failed".to_string(),
            },
        );
        match combined {
            ProviderError::Store { reason } => {
                assert!(reason.contains("model list fetch failed"), "{reason}");
                assert!(reason.contains("keychain"), "{reason}");
                assert!(reason.contains("access denied"), "{reason}");
            }
            other => panic!("expected Store, got {other:?}"),
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
        for bad in [
            "",
            "Office",
            "has space",
            "under_score",
            "openrouter",
            "agentrouter",
            "ollama",
            "google",
        ] {
            assert!(
                validate_custom_id(bad).is_err(),
                "{bad:?} must not become a provider id"
            );
        }
    }

    #[test]
    fn retired_ids_are_free_for_custom_use() {
        // anthropic/openai left the builtin set (D125): nothing reserves
        // them anymore, so a custom row may reuse the name.
        for id in ["anthropic", "openai"] {
            assert_eq!(validate_custom_id(id).expect("retired id"), id);
        }
    }

    #[test]
    fn only_ollama_allows_a_blank_key() {
        assert!(allows_blank_key("ollama"));
        assert!(allows_blank_key("  ollama  "));
        for id in ["openrouter", "agentrouter", "google", "office-gateway", ""] {
            assert!(!allows_blank_key(id), "{id:?} must require a key");
        }
    }

    #[test]
    fn blank_key_sends_no_auth_header() {
        assert_eq!(auth_header(""), None);
        assert_eq!(auth_header("   "), None);
        assert_eq!(auth_header("sk-live"), Some("Bearer sk-live".to_string()));
        assert_eq!(
            auth_header("  sk-live  "),
            Some("Bearer sk-live".to_string())
        );
    }

    #[test]
    fn the_set_and_refresh_blank_gate_refuses_everything_but_keyless_rows() {
        // The gate BOTH `provider_set_key` and `provider_refresh` stand
        // behind (D125, review 33): the FE now permits a blank keyless save
        // (A-views), so this condition is the only thing between a silent
        // empty key and ollama's auth-less proof fetch. Refuse a blank for
        // every keyed row; pass ollama through, blank or not.
        assert!(blank_key_rejected("openrouter", "   "));
        assert!(blank_key_rejected("google", ""));
        assert!(blank_key_rejected("office-gateway", "\t"));
        assert!(!blank_key_rejected("ollama", "   "));
        assert!(!blank_key_rejected("ollama", ""));
        assert!(!blank_key_rejected("openrouter", "sk-live"));
        assert!(!blank_key_rejected("ollama", "sk-live"));
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
