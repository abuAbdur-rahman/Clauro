//! Task 003 (providers) — per-provider rows and model lists (RED).
//!
//! The picker must show only configured providers' models, so the store owns
//! two configuration tables beside the transcript: `provider` (one row per
//! added provider, with its kind, endpoint, and model-list freshness) and
//! `provider_model` (the fetched model ids). Keys stay in the keyring —
//! nothing secret-shaped ever reaches these tables (D43).
//!
//! Both tables are configuration, not transcript: `provider.models_fetched_at`
//! is stamped on every refresh and a refresh *replaces* the model list, so
//! they are mutable by documented write paths, exactly like `project.name`.
//! `message` and `block` stay fully append-only; the scan in
//! `tests/append_only.rs` keeps proving it.

use clauro_store::{NewProvider, ProviderKind, ProviderModel, Store};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn fresh() -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("clauro-prov-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).expect("scratch");
        Self { path }
    }

    fn db(&self) -> PathBuf {
        self.path.join("s.db")
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn anthropic(now: i64) -> NewProvider {
    NewProvider {
        id: "anthropic".to_string(),
        kind: ProviderKind::Anthropic,
        display_name: "Anthropic".to_string(),
        base_url: None,
        added_at: now,
    }
}

#[test]
fn adding_a_provider_stores_its_endpoint_shape() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open");
    store.insert_provider(anthropic(100)).expect("insert");
    let row = store
        .get_provider("anthropic")
        .expect("read")
        .expect("present");
    assert_eq!(row.display_name, "Anthropic");
    assert_eq!(row.kind, ProviderKind::Anthropic);
    assert_eq!(row.base_url, None);
    assert_eq!(row.models_fetched_at, None, "no fetch has happened yet");
}

#[test]
fn custom_provider_keeps_its_base_url() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open");
    store
        .insert_provider(NewProvider {
            id: "office-gateway".to_string(),
            kind: ProviderKind::OpenAiCompatible,
            display_name: "Office gateway".to_string(),
            base_url: Some("https://llm.office.example/v1".to_string()),
            added_at: 100,
        })
        .expect("insert");
    let row = store
        .get_provider("office-gateway")
        .expect("read")
        .expect("present");
    assert_eq!(
        row.base_url.as_deref(),
        Some("https://llm.office.example/v1")
    );
}

#[test]
fn adding_the_same_provider_twice_fails_typed() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open");
    store.insert_provider(anthropic(100)).expect("first");
    let err = store
        .insert_provider(anthropic(200))
        .expect_err("duplicate");
    assert!(
        !err.to_string().is_empty(),
        "a typed error, never a panic: {err:?}"
    );
}

#[test]
fn replacing_models_swaps_the_whole_list_and_stamps_freshness() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open");
    store.insert_provider(anthropic(100)).expect("insert");
    store
        .replace_provider_models(
            "anthropic",
            &[ProviderModel {
                id: "claude-x".to_string(),
                display_name: "Claude X".to_string(),
            }],
            1_000,
        )
        .expect("first fetch");
    store
        .replace_provider_models(
            "anthropic",
            &[
                ProviderModel {
                    id: "claude-y".to_string(),
                    display_name: "Claude Y".to_string(),
                },
                ProviderModel {
                    id: "claude-z".to_string(),
                    display_name: "Claude Z".to_string(),
                },
            ],
            2_000,
        )
        .expect("refresh");
    let models = store.list_provider_models("anthropic").expect("list");
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["claude-y", "claude-z"],
        "refresh replaces, never merges"
    );
    let row = store
        .get_provider("anthropic")
        .expect("read")
        .expect("present");
    assert_eq!(row.models_fetched_at, Some(2_000));
}

#[test]
fn replacing_models_for_an_unknown_provider_fails_typed() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open");
    let err = store
        .replace_provider_models("ghost", &[], 1_000)
        .expect_err("unknown provider");
    assert!(
        matches!(err, clauro_store::StoreError::NotFound(_)),
        "typed NotFound, never an invented row: {err:?}"
    );
}

#[test]
fn removing_a_provider_removes_its_models_and_nothing_else() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open");
    store.insert_provider(anthropic(100)).expect("anthropic");
    store
        .insert_provider(NewProvider {
            id: "other".to_string(),
            kind: ProviderKind::OpenAiCompatible,
            display_name: "Other".to_string(),
            base_url: Some("https://other.example/v1".to_string()),
            added_at: 100,
        })
        .expect("other");
    for provider in ["anthropic", "other"] {
        store
            .replace_provider_models(
                provider,
                &[ProviderModel {
                    id: "m1".to_string(),
                    display_name: "M1".to_string(),
                }],
                1_000,
            )
            .expect("models");
    }
    assert!(store.remove_provider("anthropic").expect("remove"));
    assert!(store.get_provider("anthropic").expect("read").is_none());
    assert!(
        store
            .list_provider_models("anthropic")
            .expect("list")
            .is_empty(),
        "models go with their provider"
    );
    assert_eq!(
        store.list_provider_models("other").expect("list").len(),
        1,
        "the other provider is untouched"
    );
    assert!(!store.remove_provider("anthropic").expect("second remove"));
}

#[test]
fn list_providers_returns_everything_in_id_order() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open");
    store
        .insert_provider(NewProvider {
            id: "zeta".to_string(),
            kind: ProviderKind::OpenAiCompatible,
            display_name: "Z".to_string(),
            base_url: Some("https://z.example/v1".to_string()),
            added_at: 100,
        })
        .expect("zeta");
    store.insert_provider(anthropic(100)).expect("anthropic");
    let ids: Vec<String> = store
        .list_providers()
        .expect("list")
        .into_iter()
        .map(|p| p.id)
        .collect();
    assert_eq!(ids, vec!["anthropic".to_string(), "zeta".to_string()]);
}

#[test]
fn a_v1_database_migrates_to_provider_tables() {
    // A database created before providers existed opens with the new tables
    // and keeps its transcript rows. Simulated by dropping the two tables and
    // rewinding `user_version`, which is exactly the v1 shape.
    let dir = TestDir::fresh();
    {
        let store = Store::open(&dir.db()).expect("open");
        store.insert_provider(anthropic(100)).expect("insert");
    }
    {
        let conn = rusqlite::Connection::open(dir.db()).expect("raw open");
        conn.execute_batch(
            "DROP TABLE provider_model; DROP TABLE provider; PRAGMA user_version = 1;",
        )
        .expect("rewind to v1");
    }
    let store = Store::open(&dir.db()).expect("reopen migrates");
    store
        .insert_provider(anthropic(100))
        .expect("providers work after migrate");
    assert!(
        store.table_names().contains(&"provider".to_string()),
        "provider table exists after migration"
    );
}
