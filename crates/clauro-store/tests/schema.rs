//! Task 004 — SQLite schema and the append-only log (RED).
//!
//! Every test here hangs off `CONTRACTS.md` §1. The `Store` API they call does
//! not exist yet, so this file must fail to compile — that is the point. A
//! test that has never failed proves nothing (`AGENTS.md` §6).

use clauro_store::{
    MessageRole, NewArtifact, NewAttachment, NewBlock, NewCompactionEvent, NewMemory, NewMessage,
    NewProject, NewThread, NewToolResult, NewUsage, Store,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A unique scratch directory under the OS temp dir. Removed on drop.
/// `std`-only on purpose: no `tempfile` dependency for one helper.
struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn fresh() -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "clauro-004-{}-{}-{}",
            std::process::id(),
            n,
            now_ms()
        ));
        std::fs::create_dir_all(&path).expect("scratch dir must be creatable");
        Self { path }
    }

    fn db(&self) -> PathBuf {
        self.path.join("test.db")
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock must move forward")
        .as_millis() as i64
}

/// Open a file-backed store and seed one project + one thread.
/// Returns the store and the thread id.
fn seeded(dir: &TestDir) -> (Store, String) {
    let store = Store::open(&dir.db()).expect("open must succeed");
    store
        .insert_project(NewProject {
            id: "p1".to_string(),
            name: "proj".to_string(),
            instructions: String::new(),
            bash_enabled: false,
        })
        .expect("project insert must succeed");
    store
        .insert_thread(NewThread {
            id: "t1".to_string(),
            project_id: Some("p1".to_string()),
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: "sys".to_string(),
            tools_frozen: "[]".to_string(),
        })
        .expect("thread insert must succeed");
    (store, "t1".to_string())
}

fn msg(store: &Store, id: &str, thread: &str, seq: i64) {
    store
        .insert_message(NewMessage {
            id: id.to_string(),
            thread_id: thread.to_string(),
            seq,
            role: MessageRole::User,
            created_at: now_ms(),
        })
        .expect("message insert must succeed");
}

fn block(store: &Store, id: &str, message: &str, seq: i64, generation: i64) {
    store
        .insert_block(NewBlock {
            id: id.to_string(),
            message_id: message.to_string(),
            seq,
            kind: "text".to_string(),
            payload: r#"{"text":"hi"}"#.to_string(),
            boundary: None,
            is_summary: false,
            generation,
            signature: None,
            dropped: false,
        })
        .expect("block insert must succeed");
}

// ── schema shape ─────────────────────────────────────────────────────────────

#[test]
fn schema_creates_all_fourteen_tables() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open must succeed");
    let mut names = store.table_names();
    names.sort();
    assert_eq!(
        names,
        vec![
            "account_setting",
            "artifact",
            "attachment",
            "block",
            "compaction_event",
            "memory",
            "memory_setting",
            "message",
            "project",
            "provider",
            "provider_model",
            "thread",
            "tool_result",
            "usage",
        ],
        "CONTRACTS.md §1 defines exactly fourteen tables"
    );
}

#[test]
fn block_carries_compaction_and_thinking_columns() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open must succeed");
    let sql = store.table_sql("block").expect("block must exist");
    for col in [
        "boundary",
        "is_summary",
        "generation",
        "signature",
        "dropped",
    ] {
        assert!(sql.contains(col), "block DDL must mention column {col}");
    }
}

#[test]
fn usage_carries_two_channels_run_id_and_iterations() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open must succeed");
    let sql = store.table_sql("usage").expect("usage must exist");
    for col in [
        "summary_tokens",
        "summary_used_tokens",
        "run_id",
        "iterations",
        "context_budget",
    ] {
        assert!(sql.contains(col), "usage DDL must mention column {col}");
    }
}

#[test]
fn tool_result_ddl_names_all_four_statuses_and_the_unique_pair() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open must succeed");
    let sql = store
        .table_sql("tool_result")
        .expect("tool_result must exist");
    for status in ["'ok'", "'error'", "'aborted'", "'rejected'"] {
        assert!(sql.contains(status), "tool_result DDL must admit {status}");
    }
    assert!(
        sql.contains("UNIQUE (thread_id, tool_call_id)"),
        "tool_result must be unique on (thread_id, tool_call_id)"
    );
}

#[test]
fn pragmas_are_wal_and_foreign_keys_on() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.db()).expect("open must succeed");
    assert_eq!(store.journal_mode(), "wal", "journal_mode must be WAL");
    assert!(store.foreign_keys_on(), "foreign_keys must be ON");
}

// ── append-only behaviour ────────────────────────────────────────────────────

#[test]
fn seq_gaps_are_legal() {
    let dir = TestDir::fresh();
    let (store, t) = seeded(&dir);
    msg(&store, "m1", &t, 1);
    msg(&store, "m2", &t, 5);
    block(&store, "b1", "m1", 0, 0);
    block(&store, "b2", "m2", 0, 0);
    let rows = store.blocks_for_message("m2");
    assert_eq!(rows.len(), 1, "gapped seq rows must both persist");
    assert_eq!(rows[0].generation, 0);
}

#[test]
fn generation_is_non_decreasing_and_regression_is_a_typed_error() {
    let dir = TestDir::fresh();
    let (store, t) = seeded(&dir);
    msg(&store, "m1", &t, 1);
    msg(&store, "m2", &t, 2);
    block(&store, "b1", "m1", 0, 0);
    block(&store, "b2", "m2", 0, 1);
    let err = store
        .insert_block(NewBlock {
            id: "b3".to_string(),
            message_id: "m2".to_string(),
            seq: 1,
            kind: "text".to_string(),
            payload: "{}".to_string(),
            boundary: None,
            is_summary: false,
            generation: 0,
            signature: None,
            dropped: false,
        })
        .expect_err("generation regression must fail");
    assert!(
        err.to_string().contains("generation"),
        "error must name generation, got: {err}"
    );
}

#[test]
fn summary_channel_is_never_folded_into_totals() {
    let dir = TestDir::fresh();
    let (store, t) = seeded(&dir);
    store
        .insert_usage(NewUsage {
            id: "u1".to_string(),
            thread_id: t.clone(),
            message_id: None,
            run_id: "r1".to_string(),
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 0,
            cache_write_tokens: 10,
            summary_tokens: 9_999,
            summary_used_tokens: Some(8_888),
            iterations: None,
            context_budget: None,
            created_at: now_ms(),
        })
        .expect("usage insert must succeed");
    let totals = store.usage_totals(&t);
    assert_eq!(totals.input_tokens, 100);
    assert_eq!(totals.output_tokens, 50);
    assert_eq!(totals.cache_write_tokens, 10);
    assert!(
        totals.input_tokens != 9_999 && totals.output_tokens != 8_888,
        "summary_* must not leak into ordinary totals (D57)"
    );
}

#[test]
fn tool_result_pair_is_unique_per_thread_and_call() {
    let dir = TestDir::fresh();
    let (store, t) = seeded(&dir);
    let mk = |id: &str| NewToolResult {
        id: id.to_string(),
        thread_id: t.clone(),
        tool_call_id: "call-1".to_string(),
        tool_name: "fs".to_string(),
        status: clauro_core::ToolStatus::Ok,
        preview: "p".to_string(),
        preview_path: None,
        full_path: None,
        output_bytes: 1,
        created_at: now_ms(),
    };
    store
        .insert_tool_result(mk("r1"))
        .expect("first insert wins");
    store
        .insert_tool_result(mk("r2"))
        .expect_err("duplicate (thread_id, tool_call_id) must fail");
}

#[test]
fn every_mutable_column_has_its_single_write_path() {
    let dir = TestDir::fresh();
    let (store, _) = seeded(&dir);
    store
        .rename_project("p1", "renamed")
        .expect("rename must work");
    store
        .set_project_instructions("p1", "be kind")
        .expect("instructions must work");
    store
        .set_project_bash_enabled("p1", true)
        .expect("bash opt-in must work");
    store
        .archive_project("p1", Some(now_ms()))
        .expect("archive must work");
    store
        .retitle_thread("t1", Some("hello".to_string()))
        .expect("retitle must work");
    store
        .insert_memory(NewMemory {
            id: "mem1".to_string(),
            project_id: Some("p1".to_string()),
            topic: "prefs".to_string(),
            path: "/memories/prefs".to_string(),
            body: "v1".to_string(),
            sensitive: false,
            updated_at: now_ms(),
        })
        .expect("memory insert must work");
    let rev = store
        .memory_replace_body("mem1", "v2", now_ms())
        .expect("str_replace must work");
    assert_eq!(
        rev, 2,
        "str_replace bumps revision, never rewrites blind (D7)"
    );
    let mem = store.get_memory("mem1").expect("memory must be readable");
    assert_eq!(mem.body, "v2");
    assert_eq!(mem.revision, 2);
    store
        .set_memory_sensitive("mem1", true, now_ms())
        .expect("sensitive flag must work");
    store
        .upsert_memory_setting("t1", true, false)
        .expect("memory_setting must work");
    store
        .upsert_account_setting(false, false)
        .expect("account_setting must work");
    store
        .insert_artifact(NewArtifact {
            id: "a1".to_string(),
            thread_id: "t1".to_string(),
            title: "demo".to_string(),
            media_type: "text/html".to_string(),
            source_path: "artifacts/a1/1/source".to_string(),
            created_at: now_ms(),
        })
        .expect("artifact insert must work");
    store
        .set_artifact_compiled_path("a1", "artifacts/a1/1/compiled")
        .expect("compiled_path is set once after the Worker transform");
}

/// The drawer's production producer (D121) reads the thread's newest artifact
/// row; refresh bumps, never rewrites, so "latest" is a real query and not a
/// scan of every version the thread ever wrote.
#[test]
fn latest_artifact_is_the_newest_row_of_that_thread_and_none_when_empty() {
    let dir = TestDir::fresh();
    let (store, _) = seeded(&dir);
    for id in ["t-latest", "t-other"] {
        store
            .insert_thread(NewThread {
                id: id.to_string(),
                project_id: Some("p1".to_string()),
                title: None,
                incognito: false,
                memory_off: false,
                system_frozen: "sys".to_string(),
                tools_frozen: "[]".to_string(),
            })
            .expect("thread insert must succeed");
    }
    let mk = |id: &str, thread: &str, title: &str, created: i64| NewArtifact {
        id: id.to_string(),
        thread_id: thread.to_string(),
        title: title.to_string(),
        media_type: "text/html".to_string(),
        source_path: format!("artifacts/{id}/source"),
        created_at: created,
    };
    store
        .insert_artifact(mk("a-first", "t-latest", "first", 100))
        .expect("insert");
    store
        .insert_artifact(mk("a-second", "t-latest", "second", 200))
        .expect("insert");
    store
        .insert_artifact(mk("a-refresh", "t-latest", "refreshed", 300))
        .expect("insert");
    // Another thread's artifact must never leak across.
    store
        .insert_artifact(mk("a-elsewhere", "t-other", "elsewhere", 400))
        .expect("insert");

    let latest = store
        .latest_artifact("t-latest")
        .expect("newest row of that thread");
    assert_eq!(latest.id, "a-refresh", "newest by created_at wins");
    assert_eq!(latest.title, "refreshed");
    assert_eq!(latest.media_type, "text/html");
    assert_eq!(latest.source_path, "artifacts/a-refresh/source");
    assert_eq!(latest.created_at, 300);
    assert_eq!(latest.version, 1, "a fresh insert is version one");

    assert!(
        store.latest_artifact("t-never-used").is_none(),
        "an empty thread is None, not an error"
    );
}

#[test]
fn global_memory_paths_are_unique_while_project_paths_scope_per_project() {
    let dir = TestDir::fresh();
    let (store, _) = seeded(&dir);
    let mk = |id: &str, project: Option<&str>| NewMemory {
        id: id.to_string(),
        project_id: project.map(str::to_string),
        topic: "t".to_string(),
        path: "/memories/same".to_string(),
        body: "b".to_string(),
        sensitive: false,
        updated_at: now_ms(),
    };
    store
        .insert_memory(mk("g1", None))
        .expect("first global insert wins");
    store
        .insert_memory(mk("g2", None))
        .expect_err("duplicate global path must fail");
    // Same path in a project is a different scope and must succeed.
    store
        .insert_memory(mk("p1m", Some("p1")))
        .expect("project scope is separate from global");
}

#[test]
fn attachment_dedupe_scopes_to_the_project_not_globally() {
    let dir = TestDir::fresh();
    let (store, _) = seeded(&dir);
    store
        .insert_project(NewProject {
            id: "p2".to_string(),
            name: "other".to_string(),
            instructions: String::new(),
            bash_enabled: false,
        })
        .expect("second project must insert");
    let mk = |id: &str, project: Option<&str>| NewAttachment {
        id: id.to_string(),
        project_id: project.map(str::to_string),
        path: "uploads/f.png".to_string(),
        content_hash: "hash-abc".to_string(),
        bytes: 3,
        media_type: "image/png".to_string(),
        name: "f.png".to_string(),
        created_at: now_ms(),
    };
    store
        .insert_attachment(mk("at1", Some("p1")))
        .expect("first insert wins");
    store
        .insert_attachment(mk("at2", Some("p1")))
        .expect_err("same hash in the same project must fail (D52)");
    store
        .insert_attachment(mk("at3", Some("p2")))
        .expect("same bytes in another project are not observable (D52)");
}

#[test]
fn compaction_generation_advances_strictly_by_one() {
    let dir = TestDir::fresh();
    let (store, t) = seeded(&dir);
    let mk = |id: &str, generation: i64| NewCompactionEvent {
        id: id.to_string(),
        thread_id: t.clone(),
        generation,
        summary_block: "b-sum".to_string(),
        covers_from: 1,
        covers_to: 4,
        summary_tokens: 10,
        summary_used_tokens: None,
        created_at: now_ms(),
    };
    store
        .insert_compaction_event(mk("c-bad", 5))
        .expect_err("first compaction must be generation 1, not 5");
    store
        .insert_compaction_event(mk("c1", 1))
        .expect("generation 1 must commit");
    store
        .insert_compaction_event(mk("c3", 3))
        .expect_err("skipping to 3 must fail");
    store
        .insert_compaction_event(mk("c2", 2))
        .expect("generation 2 must commit");
    assert_eq!(store.compaction_generations(&t), vec![1, 2]);
}
