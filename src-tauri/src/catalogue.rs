//! Model catalogue: `models.dev/api.json`, fetched at runtime and cached (D23).
//!
//! MIT, ~200 providers, ~5.3 MB — larger than the entire binary budget, so it
//! is **never bundled**. Fetch once, cache with a TTL, fall back to cache on
//! failure. An offline start with a cache shows cached models; an offline start
//! with no cache is an honest empty state, never a broken picker.
//!
//! Design for testability: everything here is a pure function over injected
//! bytes, paths, and clocks. The Tauri commands compose them with real
//! directories. No network in tests, no clock in tests.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Catalogue time-to-live. A day: limits change on vendor-release cadence, not
/// by the minute, and every refresh is 5 MB of someone's bandwidth.
pub const CATALOGUE_TTL_SECS: u64 = 24 * 60 * 60;

/// Cache filename inside the app-data directory.
pub const CACHE_FILE: &str = "models-dev-cache.json";

/// models.dev source of truth (D23). Fetched at runtime, never bundled.
pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";

/// Enrichment TTL: limits change on vendor-release cadence, not by the
/// minute. Longer than the catalogue's own TTL was — enrichment is a
/// background fact, not a picker blocker.
pub const ENRICHMENT_TTL_SECS: u64 = 7 * 24 * 60 * 60;

/// The subset of a models.dev model entry the picker consumes.
/// Catalogue `limit.context` → `context_window`, `limit.output` → `max_output`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogueModel {
    pub id: String,
    pub name: String,
    pub context_window: u64,
    pub max_output: u64,
    pub reasoning: bool,
    pub tool_call: bool,
}

/// One provider's models, keyed by model id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Catalogue {
    pub providers: std::collections::BTreeMap<String, Vec<CatalogueModel>>,
}

impl Catalogue {
    pub fn model_count(&self) -> usize {
        self.providers.values().map(Vec::len).sum()
    }

    /// Lookup by provider + model id. Exercised by unit tests; first
    /// production consumer is the adapter layer (005+).
    #[allow(dead_code)]
    pub fn find(&self, provider: &str, id: &str) -> Option<&CatalogueModel> {
        self.providers.get(provider)?.iter().find(|m| m.id == id)
    }
}

/// Typed catalogue failure. Unknown models are NOT an error here — lookup
/// misses return `None` and the caller degrades to a typed notice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CatalogueError {
    Network { reason: String },
    CorruptCache { reason: String },
}

impl std::fmt::Display for CatalogueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CatalogueError::Network { reason } => write!(f, "catalogue fetch failed: {reason}"),
            CatalogueError::CorruptCache { reason } => {
                write!(f, "catalogue cache corrupt: {reason}")
            }
        }
    }
}

impl std::error::Error for CatalogueError {}

// ── parsing ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RawLimit {
    #[serde(default)]
    context: Option<u64>,
    #[serde(default)]
    output: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RawModel {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    limit: Option<RawLimit>,
    #[serde(default)]
    reasoning: bool,
    #[serde(default)]
    tool_call: bool,
}

#[derive(Debug, Deserialize)]
struct RawProvider {
    #[serde(default)]
    models: std::collections::BTreeMap<String, RawModel>,
}

/// Parse catalogue bytes. Unknown fields are ignored — the catalogue adds
/// fields on vendor cadence and the parser must not be stricter than the UI.
/// Entries without limits are SKIPPED: a zero-limit guess would under-reserve
/// the reply and overflow the window (CONTRACTS.md §5).
pub fn parse_catalogue(bytes: &[u8]) -> Result<Catalogue, CatalogueError> {
    let raw: std::collections::BTreeMap<String, RawProvider> = serde_json::from_slice(bytes)
        .map_err(|e| CatalogueError::CorruptCache {
            reason: format!("invalid JSON: {e}"),
        })?;
    let mut out = Catalogue::default();
    for (provider_id, provider) in raw {
        let mut models: Vec<CatalogueModel> = provider
            .models
            .into_iter()
            .filter_map(|(key, m)| {
                let limit = m.limit?;
                // Zero is not a limit, it is the absence of one. The live
                // catalogue carries 235 such entries (router placeholders).
                // They are skipped, never zero-guessed (CONTRACTS.md §5).
                let context = limit.context.filter(|&c| c > 0)?;
                let output = limit.output.filter(|&o| o > 0)?;
                Some(CatalogueModel {
                    id: if m.id.is_empty() { key } else { m.id },
                    name: m.name,
                    context_window: context,
                    max_output: output,
                    reasoning: m.reasoning,
                    tool_call: m.tool_call,
                })
            })
            .collect();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        if !models.is_empty() {
            out.providers.insert(provider_id, models);
        }
    }
    Ok(out)
}

// ── cache ──────────────────────────────────────────────────────────────────

/// A cache read: bytes plus the age signal the TTL decision needs.
pub struct CacheRead {
    pub bytes: Vec<u8>,
    pub modified_secs: u64,
}

/// Read the cache file. Absent file is `Ok(None)` — first run, not an error.
pub fn read_cache(dir: &Path) -> Result<Option<CacheRead>, CatalogueError> {
    let path = dir.join(CACHE_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(CatalogueError::CorruptCache {
                reason: format!("cannot read {}: {e}", path.display()),
            })
        }
    };
    let modified_secs = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(Some(CacheRead {
        bytes,
        modified_secs,
    }))
}

/// Freshness over an injected clock. `now_secs` is a parameter so tests never
/// sleep and never read the wall clock.
pub fn is_fresh(modified_secs: u64, now_secs: u64, ttl_secs: u64) -> bool {
    now_secs.saturating_sub(modified_secs) < ttl_secs
}

/// Write bytes atomically-ish: temp file plus rename, so a crashed write never
/// leaves a half catalogue behind.
pub fn write_cache(dir: &Path, bytes: &[u8]) -> Result<(), CatalogueError> {
    std::fs::create_dir_all(dir).map_err(|e| CatalogueError::CorruptCache {
        reason: format!("cannot create {}: {e}", dir.display()),
    })?;
    let tmp = dir.join(format!("{CACHE_FILE}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| CatalogueError::CorruptCache {
        reason: format!("cannot write cache: {e}"),
    })?;
    std::fs::rename(&tmp, dir.join(CACHE_FILE)).map_err(|e| CatalogueError::CorruptCache {
        reason: format!("cannot commit cache: {e}"),
    })?;
    Ok(())
}

// ── resolution ─────────────────────────────────────────────────────────────

/// Resolve one catalogue: prefer `fresh_bytes` when present, else the cache,
/// else nothing. Returns the catalogue and whether it came from cache, so the
/// UI can say "cached" honestly instead of pretending to be live.
pub fn resolve(
    fresh_bytes: Option<&[u8]>,
    cache: Option<&CacheRead>,
) -> Result<(Catalogue, bool), CatalogueError> {
    if let Some(bytes) = fresh_bytes {
        return parse_catalogue(bytes).map(|c| (c, false));
    }
    if let Some(cached) = cache {
        return parse_catalogue(&cached.bytes).map(|c| (c, true));
    }
    Ok((Catalogue::default(), true))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal models.dev-shaped fixture. Full fixtures are network-shaped;
    /// this is the shape that matters: provider → models → limit.
    const FIXTURE: &str = r#"{
        "anthropic": { "id": "anthropic", "name": "Anthropic", "models": {
            "claude-haiku-4-5": { "id": "claude-haiku-4-5", "name": "Claude Haiku 4.5",
                "limit": { "context": 200000, "output": 64000 },
                "reasoning": true, "tool_call": true },
            "mystery-model": { "id": "mystery-model", "name": "No Limits",
                "reasoning": false, "tool_call": false }
        }},
        "openai": { "id": "openai", "name": "OpenAI", "models": {
            "gpt-x": { "id": "gpt-x", "name": "GPT X",
                "limit": { "context": 128000, "output": 16384 },
                "reasoning": false, "tool_call": true }
        }}
    }"#;

    #[test]
    fn parses_limits_and_skips_limitless_entries() {
        let cat = parse_catalogue(FIXTURE.as_bytes()).expect("fixture must parse");
        assert_eq!(cat.model_count(), 2);
        let haiku = cat
            .find("anthropic", "claude-haiku-4-5")
            .expect("haiku present");
        assert_eq!(haiku.context_window, 200_000);
        assert_eq!(haiku.max_output, 64_000);
        assert!(haiku.reasoning && haiku.tool_call);
        // `mystery-model` has no limit block: skipped, never zero-guessed.
        assert!(cat.find("anthropic", "mystery-model").is_none());
    }

    #[test]
    fn explicit_zero_limits_are_skipped_not_stored() {
        // The live catalogue carries router placeholders with explicit zero
        // limits. A stored zero would under-reserve the reply.
        let fixture = r#"{"prov": {"id": "prov", "models": {
            "zeroed": {"id": "zeroed", "name": "Z", "limit": {"context": 0, "output": 0}},
            "half": {"id": "half", "name": "H", "limit": {"context": 1000, "output": 0}},
            "real": {"id": "real", "name": "R", "limit": {"context": 1000, "output": 500}}
        }}}"#;
        let cat = parse_catalogue(fixture.as_bytes()).expect("fixture must parse");
        assert_eq!(cat.model_count(), 1);
        assert!(cat.find("prov", "real").is_some());
    }

    #[test]
    fn invalid_json_is_corrupt_cache_not_panic() {
        match parse_catalogue(b"not json") {
            Err(CatalogueError::CorruptCache { .. }) => {}
            other => panic!("expected CorruptCache, got {other:?}"),
        }
    }

    #[test]
    fn ttl_boundaries() {
        // Fresh at exactly now; stale at exactly TTL; future mtime is fresh.
        assert!(is_fresh(1000, 1000, CATALOGUE_TTL_SECS));
        assert!(!is_fresh(0, CATALOGUE_TTL_SECS, CATALOGUE_TTL_SECS));
        assert!(is_fresh(2000, 1000, CATALOGUE_TTL_SECS));
    }

    #[test]
    fn fresh_beats_cache_cache_beats_nothing() {
        let cached = CacheRead {
            bytes: FIXTURE.as_bytes().to_vec(),
            modified_secs: 0,
        };
        // Fresh wins and reports live.
        let (cat, from_cache) = resolve(Some(FIXTURE.as_bytes()), Some(&cached)).expect("resolve");
        assert!(!from_cache && cat.model_count() == 2);
        // No fresh: cache wins and reports cached.
        let (cat, from_cache) = resolve(None, Some(&cached)).expect("resolve");
        assert!(from_cache && cat.model_count() == 2);
        // Neither: honest empty, not an error.
        let (cat, _) = resolve(None, None).expect("resolve");
        assert_eq!(cat.model_count(), 0);
    }

    #[test]
    fn cache_round_trips_through_tempdir() {
        let dir = std::env::temp_dir().join(format!(
            "clauro-cat-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        // Absent cache is None, not an error.
        assert!(read_cache(&dir).expect("read").is_none());
        write_cache(&dir, FIXTURE.as_bytes()).expect("write");
        // No temp file left behind.
        assert!(!dir.join(format!("{CACHE_FILE}.tmp")).exists());
        let back = read_cache(&dir).expect("read").expect("present");
        assert_eq!(back.bytes, FIXTURE.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
