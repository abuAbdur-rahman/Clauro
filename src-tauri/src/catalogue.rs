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

/// Upper bound on catalogue bytes, read or fetched. models.dev is ~5.3 MB
/// today; the cap leaves headroom while refusing an absurd file (corruption
/// or tampering) instead of reading it whole into memory (review 13 NIT).
pub const MAX_CACHE_BYTES: u64 = 16 * 1024 * 1024;

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

    /// Lookup by provider + model id. Has a production caller: the enriched
    /// provider-models join (providers.rs).
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
/// An oversized file is `CorruptCache`: the cap is checked from metadata
/// before the bytes are read, so an absurd file is refused, not swallowed
/// into memory (review 13 NIT).
pub fn read_cache(dir: &Path) -> Result<Option<CacheRead>, CatalogueError> {
    let path = dir.join(CACHE_FILE);
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_CACHE_BYTES {
            return Err(CatalogueError::CorruptCache {
                reason: format!(
                    "cache file is {} bytes, over the {} byte cap",
                    meta.len(),
                    MAX_CACHE_BYTES
                ),
            });
        }
    }
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

// ── the enrichment memo ──────────────────────────────────────────────────

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

/// One memoised parse: the cache-file mtime it came from, and the parse.
/// The file is 5.3 MB — without this every invoke re-read and re-parsed it,
/// and two ModelPickers mount at boot (A-perf-ipc).
#[derive(Debug)]
struct MemoEntry {
    mtime: SystemTime,
    catalogue: Arc<Catalogue>,
}

#[derive(Debug, Default)]
struct MemoInner {
    /// `None` until the first parse. Every lock in here is taken poison-free
    /// (D55): a panicked earlier reader degrades to a re-read, never a panic
    /// across the command boundary.
    entry: Mutex<Option<MemoEntry>>,
    /// Serialises fetch + cache write. Two cold callers must not write the
    /// same temp file at once (`write_cache` is temp-then-rename).
    fetching: Mutex<()>,
    /// Exactly one background refresh: a second picker's invoke must not
    /// start a second 5.3 MB download.
    refreshing: AtomicBool,
}

/// The parsed enrichment catalogue, memoised by cache-file mtime. `Clone`
/// hands out an `Arc` handle, which is what lets the background refresh
/// thread (`'static`) write back into the same memo the commands read.
#[derive(Debug, Clone, Default)]
pub struct EnrichmentMemo(Arc<MemoInner>);

impl EnrichmentMemo {
    fn entry(&self) -> MutexGuard<'_, Option<MemoEntry>> {
        self.0.entry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Held by whoever fetches and writes the cache, so writers never
    /// collide on the temp file.
    pub(crate) fn fetch_guard(&self) -> MutexGuard<'_, ()> {
        self.0
            .fetching
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Claim the one background refresh. `false` means one is already running.
    pub(crate) fn try_begin_refresh(&self) -> bool {
        self.0
            .refreshing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Releases the claim on drop, so a panicking refresh cannot wedge the
    /// flag closed and silently stop every future refresh.
    pub(crate) fn refreshing_guard(&self) -> RefreshGuard {
        RefreshGuard(self.clone())
    }

    fn store(&self, mtime: SystemTime, catalogue: Arc<Catalogue>) {
        *self.entry() = Some(MemoEntry { mtime, catalogue });
    }
}

pub(crate) struct RefreshGuard(EnrichmentMemo);

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        self.0 .0.refreshing.store(false, Ordering::SeqCst);
    }
}

/// What a load decided the caller must do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnrichmentAction {
    /// Parsed data inside its TTL: use it, fetch nothing.
    Fresh,
    /// Parsed data past its TTL: answer from it now, refresh behind the
    /// response — a stale cache must never cost the caller a 60 s fetch.
    RefreshInBackground,
    /// Nothing usable at all: fetch now. The caller is on the blocking pool.
    FetchNow,
}

/// One load: the data to answer with (if any) plus the fetch decision.
#[derive(Debug)]
pub struct EnrichmentLoad {
    pub catalogue: Option<Arc<Catalogue>>,
    pub action: EnrichmentAction,
}

fn system_time_secs(t: SystemTime) -> u64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Load the enrichment catalogue for one picker read: stat the cache, answer
/// from the memo when the file has not moved, otherwise read + parse once and
/// memoise it. Pure over the injected reader and clock — no network here, no
/// wall clock in tests. The fetch decision comes back as
/// [`EnrichmentAction`]; performing it is the caller's job.
pub fn load_enrichment(
    dir: &Path,
    memo: &EnrichmentMemo,
    now_secs: u64,
    read: impl FnOnce(&Path) -> Result<Option<CacheRead>, CatalogueError>,
) -> EnrichmentLoad {
    let path = dir.join(CACHE_FILE);
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();

    // Memo hit: same file, same version — one stat, no read, no parse. This
    // is the boot path's win: the second ModelPicker costs a stat.
    if let Some(mtime) = mtime {
        let cached = memo.entry();
        if let Some(entry) = cached.as_ref().filter(|e| e.mtime == mtime) {
            let fresh = is_fresh(system_time_secs(mtime), now_secs, ENRICHMENT_TTL_SECS);
            return EnrichmentLoad {
                catalogue: Some(entry.catalogue.clone()),
                action: if fresh {
                    EnrichmentAction::Fresh
                } else {
                    EnrichmentAction::RefreshInBackground
                },
            };
        }
    }

    // Memo miss: read and parse once, then store it for every later invoke.
    match read(dir) {
        Ok(Some(cached)) => {
            let fresh = is_fresh(cached.modified_secs, now_secs, ENRICHMENT_TTL_SECS);
            match parse_catalogue(&cached.bytes) {
                Ok(cat) => {
                    let catalogue = Arc::new(cat);
                    if let Some(mtime) = mtime {
                        memo.store(mtime, catalogue.clone());
                    }
                    EnrichmentLoad {
                        catalogue: Some(catalogue),
                        action: if fresh {
                            EnrichmentAction::Fresh
                        } else {
                            EnrichmentAction::RefreshInBackground
                        },
                    }
                }
                // A fresh cache that will not parse serves nothing and does
                // not fetch (today's behaviour); a stale one falls through
                // to the fetch that replaces it.
                Err(_) => EnrichmentLoad {
                    catalogue: None,
                    action: if fresh {
                        EnrichmentAction::Fresh
                    } else {
                        EnrichmentAction::FetchNow
                    },
                },
            }
        }
        // Absent or unreadable: nothing to answer with, so the caller fetches.
        Ok(None) | Err(_) => EnrichmentLoad {
            catalogue: None,
            action: EnrichmentAction::FetchNow,
        },
    }
}

/// Write fetched bytes to the cache and memoise the parse under the file's
/// new mtime, so the next invoke is a stat instead of a 5.3 MB parse. A
/// failed cache write must not fail enrichment — memory serves this read.
/// `None` means the bytes did not parse; the caller degrades to
/// `limits_known: false`, never a panic (D55).
pub fn store_fetched(dir: &Path, memo: &EnrichmentMemo, bytes: &[u8]) -> Option<Arc<Catalogue>> {
    let _ = write_cache(dir, bytes);
    let catalogue = Arc::new(parse_catalogue(bytes).ok()?);
    if let Ok(mtime) = std::fs::metadata(dir.join(CACHE_FILE)).and_then(|m| m.modified()) {
        memo.store(mtime, catalogue.clone());
    }
    Some(catalogue)
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

    // ── the enrichment memo (A-perf-ipc) ───────────────────────────────────
    //
    // The cache is 5.3 MB. Two ModelPickers mount at boot and each invokes
    // `provider_models_enriched`, so without a memo every boot paid two full
    // reads + two full serde parses — on the WebView2 IPC thread, because the
    // command was sync. These three pin the memo's contract: one parse per
    // file version, stale data still answers, and a cold cache is the only
    // case that may fetch.

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A second fixture whose model count differs from `FIXTURE`, so a
    /// re-read after a swap is visible in the assertion.
    const SWAPPED: &str = r#"{"swap": {"id": "swap", "name": "Swap", "models": {
        "m": {"id": "m", "name": "M", "limit": { "context": 1000, "output": 500 }}
    }}} "#;

    /// A counting reader: the memo's entire job is to stop this being called
    /// again for a cache file whose mtime has not moved.
    fn counting_reader(
        count: Arc<AtomicUsize>,
    ) -> impl FnOnce(&Path) -> Result<Option<CacheRead>, CatalogueError> {
        move |dir| {
            count.fetch_add(1, Ordering::SeqCst);
            read_cache(dir)
        }
    }

    fn memo_temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "clauro-memo-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn an_unchanged_mtime_is_served_from_the_memo_without_a_second_read() {
        let dir = memo_temp_dir("hit");
        write_cache(&dir, FIXTURE.as_bytes()).expect("seed");
        let memo = EnrichmentMemo::default();
        let reads = Arc::new(AtomicUsize::new(0));

        let first = load_enrichment(&dir, &memo, 0, counting_reader(reads.clone()));
        assert_eq!(reads.load(Ordering::SeqCst), 1, "the first call reads once");
        assert_eq!(first.action, EnrichmentAction::Fresh);
        assert_eq!(first.catalogue.as_deref().expect("seeded").model_count(), 2);

        // Swap the bytes but restore the mtime: a re-read would see the
        // swap, a memo hit must not.
        let path = dir.join(CACHE_FILE);
        let mtime = std::fs::metadata(&path)
            .expect("meta")
            .modified()
            .expect("mtime");
        std::fs::write(&path, SWAPPED.as_bytes()).expect("swap");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("reopen");
        file.set_modified(mtime).expect("restore mtime");
        drop(file);

        let second = load_enrichment(&dir, &memo, 0, counting_reader(reads.clone()));
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "unchanged mtime: no second read, no second parse"
        );
        assert_eq!(
            second.catalogue.as_deref().expect("memo").model_count(),
            2,
            "the memo serves the first parse, not the swapped bytes"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_cache_still_answers_and_only_asks_for_a_background_refresh() {
        let dir = memo_temp_dir("stale");
        write_cache(&dir, FIXTURE.as_bytes()).expect("seed");
        let memo = EnrichmentMemo::default();
        let modified = std::fs::metadata(dir.join(CACHE_FILE))
            .expect("meta")
            .modified()
            .expect("mtime")
            .duration_since(std::time::UNIX_EPOCH)
            .expect("epoch")
            .as_secs();
        // Exactly at the TTL: stale, so today's code would fetch here —
        // up to 60 s of blocking on whatever thread the caller runs on.
        let now = modified + ENRICHMENT_TTL_SECS;
        let load = load_enrichment(&dir, &memo, now, read_cache);
        assert_eq!(
            load.catalogue.as_deref().expect("stale data").model_count(),
            2,
            "a stale cache is still data: it must answer, never wait on the network"
        );
        assert_eq!(
            load.action,
            EnrichmentAction::RefreshInBackground,
            "the refresh belongs behind the response, not in it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_an_absent_cache_asks_for_the_fetch() {
        let dir = memo_temp_dir("absent");
        let memo = EnrichmentMemo::default();
        let absent = load_enrichment(&dir, &memo, 0, read_cache);
        assert!(absent.catalogue.is_none());
        assert_eq!(
            absent.action,
            EnrichmentAction::FetchNow,
            "first run has nothing to answer with: the fetch is the only option left"
        );

        write_cache(&dir, FIXTURE.as_bytes()).expect("seed");
        let fresh = load_enrichment(&dir, &memo, 0, read_cache);
        assert_eq!(fresh.action, EnrichmentAction::Fresh);
        assert!(fresh.catalogue.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_poisoned_memo_lock_still_serves_the_cache() {
        let dir = memo_temp_dir("poison");
        write_cache(&dir, FIXTURE.as_bytes()).expect("seed");
        let memo = EnrichmentMemo::default();
        let held = memo.clone();
        let _ = std::thread::spawn(move || {
            let _guard = held.entry();
            panic!("poison the memo on purpose");
        })
        .join();
        // Poison-free per D55: a panicked earlier reader degrades to a
        // re-read, never a panic across the command boundary.
        let load = load_enrichment(&dir, &memo, 0, read_cache);
        assert!(load.catalogue.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_oversized_cache_file_is_refused_not_read() {
        let dir = std::env::temp_dir().join(format!("clauro-cat-oversized-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        // A sparse file reports the oversized length without writing the bytes.
        let file = std::fs::File::create(dir.join(CACHE_FILE)).expect("create");
        file.set_len(MAX_CACHE_BYTES + 1).expect("set length");
        drop(file);
        match read_cache(&dir) {
            Err(CatalogueError::CorruptCache { reason }) => {
                assert!(reason.contains("cap"), "{reason}");
            }
            Err(other) => panic!("expected CorruptCache, got {other}"),
            Ok(_) => panic!("an oversized cache must be refused, not read"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
