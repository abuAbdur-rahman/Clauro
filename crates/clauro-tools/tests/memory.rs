//! Task 008 — the memory topic store (RED).
//!
//! Six commands over project-scoped rows. The model writes memory itself —
//! no background extractor (D7). Return strings are SQLite-native, not a
//! contract. Pause/reset/off are three distinct behaviours (D8, D9).

use clauro_core::{ToolContext, ToolOutcome};
use clauro_store::{NewProject, NewThread, Store};
use clauro_tools::memory_handler;
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn dir() -> PathBuf {
    // Counter plus clock: Windows clock granularity is coarse, so nanos
    // alone collide under parallel tests sharing one DB by accident.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!(
        "clauro-008-{}-{}-{}",
        std::process::id(),
        n,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&d).expect("scratch");
    d
}

struct Setup {
    _dir: PathBuf,
    store: Arc<Mutex<Store>>,
}

fn seeded() -> Setup {
    let d = dir();
    let store = Store::open(&d.join("test.db")).expect("open");
    for (pid, name) in [("p1", "one"), ("p2", "two")] {
        store
            .insert_project(NewProject {
                id: pid.to_string(),
                name: name.to_string(),
                instructions: String::new(),
                bash_enabled: false,
            })
            .expect("project");
    }
    for (tid, pid) in [("t1", Some("p1")), ("t2", Some("p2")), ("tg", None)] {
        store
            .insert_thread(NewThread {
                id: tid.to_string(),
                project_id: pid.map(str::to_string),
                title: None,
                incognito: false,
                memory_off: false,
                system_frozen: "s".to_string(),
                tools_frozen: "[]".to_string(),
            })
            .expect("thread");
    }
    Setup {
        _dir: d,
        store: Arc::new(Mutex::new(store)),
    }
}

fn ctx(thread: &str) -> ToolContext {
    ToolContext {
        thread_id: thread.to_string(),
        call_id: "c1".to_string(),
        workspace_dir: PathBuf::from("/tmp/ws"),
    }
}

fn call(store: &Arc<Mutex<Store>>, thread: &str, input: serde_json::Value) -> ToolOutcome {
    memory_handler(store.clone())(&input, &ctx(thread))
}

fn ok_text(out: ToolOutcome) -> String {
    match out {
        ToolOutcome::Ok { preview, .. } => preview,
        other => panic!("expected ok, got: {other:?}"),
    }
}

fn err_text(out: ToolOutcome) -> String {
    match out {
        ToolOutcome::Error { message } => message,
        other => panic!("expected error, got: {other:?}"),
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

#[test]
fn view_returns_body_and_root_lists_topics() {
    let s = seeded();
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/prefs", "category": "prefs", "body": "likes tea"}),
    );
    let body = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/prefs"}),
    ));
    assert!(body.contains("likes tea"), "{body}");
    let list = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories"}),
    ));
    assert!(list.contains("prefs"), "{list}");
}

#[test]
fn root_delete_and_root_rename_are_rejected() {
    let s = seeded();
    for input in [
        json!({"command": "delete", "path": "/memories"}),
        json!({"command": "delete", "path": "/memories/"}),
        json!({"command": "rename", "old_path": "/memories", "new_path": "/memories/x"}),
    ] {
        let msg = err_text(call(&s.store, "t1", input));
        assert!(!msg.is_empty());
    }
}

#[test]
fn traversal_escapes_rejected() {
    let s = seeded();
    for evil in [
        "../x",
        "..\\x",
        "%2e%2e%2f",
        "%2E%2E%5C",
        "/memories/../../x",
    ] {
        let msg = err_text(call(
            &s.store,
            "t1",
            json!({"command": "view", "path": evil}),
        ));
        assert!(!msg.is_empty(), "{evil} must fail");
        let msg = err_text(call(
            &s.store,
            "t1",
            json!({"command": "create", "path": evil, "body": "b"}),
        ));
        assert!(!msg.is_empty(), "{evil} must fail");
    }
}

#[test]
fn secret_shaped_writes_refused_silently() {
    let s = seeded();
    for body in [
        "key sk-live-abc123xyz456",
        "ssn 123-45-6789 here",
        "-----BEGIN PRIVATE KEY-----\nabc",
        "token github_pat_abcdefghij1234567890",
    ] {
        let out = call(
            &s.store,
            "t1",
            json!({"command": "create", "path": "/memories/s", "body": body}),
        );
        assert_eq!(
            err_text(out),
            "write refused",
            "refusal reveals nothing about the guard (D43)"
        );
    }
    // Nothing persisted by refused writes.
    let list = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories"}),
    ));
    assert!(!list.contains("/memories/s"), "{list}");
}

#[test]
fn benign_lookalikes_pass() {
    let s = seeded();
    // 40-char hex git SHA with commit context must pass — a guard refusing
    // hashes gets turned off. The same run bare is refused (see secret tests).
    let sha = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
    let body = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/sha", "body": format!("commit {sha}")}),
    ));
    assert!(body.contains("sha") || body.contains("created"), "{body}");
}

#[test]
fn str_replace_needs_its_old_str() {
    let s = seeded();
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/n", "body": "alpha beta"}),
    );
    let msg = err_text(call(
        &s.store,
        "t1",
        json!({"command": "str_replace", "path": "/memories/n", "old_str": "gamma", "new_str": "delta"}),
    ));
    assert!(msg.contains("gamma") || msg.contains("not found"), "{msg}");
    let body = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/n"}),
    ));
    assert!(body.contains("alpha beta"), "unchanged: {body}");
    let out = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "str_replace", "path": "/memories/n", "old_str": "beta", "new_str": "BETA"}),
    ));
    assert!(!out.is_empty());
    let body = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/n"}),
    ));
    assert!(body.contains("BETA"), "{body}");
}

#[test]
fn insert_appends_and_splices() {
    let s = seeded();
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/l", "body": "one\nthree"}),
    );
    call(
        &s.store,
        "t1",
        json!({"command": "insert", "path": "/memories/l", "text": "two", "line": 2}),
    );
    let body = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/l"}),
    ));
    let lines: Vec<_> = body.lines().collect();
    assert_eq!(&lines[2..], &["one", "two", "three"], "{body}");
}

#[test]
fn rename_moves_path_keeping_history() {
    let s = seeded();
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/old", "body": "v1"}),
    );
    call(
        &s.store,
        "t1",
        json!({"command": "str_replace", "path": "/memories/old", "old_str": "v1", "new_str": "v2"}),
    );
    ok_text(call(
        &s.store,
        "t1",
        json!({"command": "rename", "old_path": "/memories/old", "new_path": "/memories/new"}),
    ));
    let body = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/new"}),
    ));
    assert!(body.contains("v2"), "{body}");
    // Old path gone.
    assert!(!err_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/old"})
    ))
    .is_empty());
}

#[test]
fn create_duplicate_is_an_error() {
    let s = seeded();
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/d", "body": "b"}),
    );
    let msg = err_text(call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/d", "body": "b2"}),
    ));
    assert!(!msg.is_empty());
}

// ── controls ─────────────────────────────────────────────────────────────────

#[test]
fn pause_blocks_writes_keeps_rows_resume_is_clean() {
    let s = seeded();
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/k", "body": "kept"}),
    );
    s.store
        .lock()
        .expect("lock")
        .upsert_account_setting(true, false)
        .expect("pause");
    let msg = err_text(call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/n", "body": "b"}),
    ));
    assert!(msg.contains("paused"), "{msg}");
    let msg = err_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/k"}),
    ));
    assert!(msg.contains("paused"), "{msg}");
    s.store
        .lock()
        .expect("lock")
        .upsert_account_setting(false, false)
        .expect("resume");
    let body = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/k"}),
    ));
    assert!(
        body.contains("kept"),
        "retained, nothing backfilled: {body}"
    );
}

#[test]
fn reset_needs_confirm_and_wipes_every_project() {
    let s = seeded();
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/a", "body": "b"}),
    );
    call(
        &s.store,
        "t2",
        json!({"command": "create", "path": "/memories/b", "body": "b"}),
    );
    let msg = err_text(call(&s.store, "t1", json!({"command": "reset"})));
    assert!(msg.contains("confirm"), "{msg}");
    let out = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "reset", "confirm": true}),
    ));
    assert!(out.contains('2'), "count removed: {out}");
    let la = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories"}),
    ));
    let lb = ok_text(call(
        &s.store,
        "t2",
        json!({"command": "view", "path": "/memories"}),
    ));
    assert!(
        !la.contains("/memories/a") && !lb.contains("/memories/b"),
        "{la} {lb}"
    );
}

#[test]
fn per_thread_off_blocks_reads_and_writes_and_locks() {
    let s = seeded();
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/k", "body": "b"}),
    );
    s.store
        .lock()
        .expect("lock")
        .set_thread_memory_off("t1", true)
        .expect("off before send");
    assert!(err_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/k"})
    ))
    .contains("off"));
    assert!(err_text(call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/n", "body": "b"})
    ))
    .contains("off"));
    // t2 (other project) unaffected.
    let other = ok_text(call(
        &s.store,
        "t2",
        json!({"command": "view", "path": "/memories"}),
    ));
    assert_eq!(other, "", "other scope untouched: {other}");
    // Lock: a thread with messages cannot flip the toggle.
    s.store
        .lock()
        .expect("lock")
        .insert_message(clauro_store::NewMessage {
            id: "m1".to_string(),
            thread_id: "t2".to_string(),
            seq: 1,
            role: clauro_store::MessageRole::User,
            created_at: 1,
        })
        .expect("message");
    assert!(
        s.store
            .lock()
            .expect("lock")
            .set_thread_memory_off("t2", true)
            .is_err(),
        "locks after first send (D9)"
    );
}

// ── scoping ──────────────────────────────────────────────────────────────────

#[test]
fn project_isolation_holds_both_directions() {
    let s = seeded();
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/only-a", "body": "b"}),
    );
    call(
        &s.store,
        "t2",
        json!({"command": "create", "path": "/memories/only-b", "body": "b"}),
    );
    let la = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories"}),
    ));
    let lb = ok_text(call(
        &s.store,
        "t2",
        json!({"command": "view", "path": "/memories"}),
    ));
    assert!(la.contains("only-a") && !la.contains("only-b"), "{la}");
    assert!(lb.contains("only-b") && !lb.contains("only-a"), "{lb}");
    // Same path in both projects: separate rows.
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/same", "body": "A"}),
    );
    call(
        &s.store,
        "t2",
        json!({"command": "create", "path": "/memories/same", "body": "B"}),
    );
    assert!(ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/same"})
    ))
    .contains('A'));
}

#[test]
fn sensitive_hidden_by_default_shown_when_opted_in() {
    let s = seeded();
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/s", "body": "plain note", "sensitive": true}),
    );
    let list = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories"}),
    ));
    assert!(!list.contains("/memories/s"), "filtered by default: {list}");
    s.store
        .lock()
        .expect("lock")
        .upsert_memory_setting("t1", false, true)
        .expect("opt in");
    let list = ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories"}),
    ));
    assert!(list.contains("/memories/s"), "{list}");
}

#[test]
fn memories_carry_no_thread_reference() {
    // Deleting a chat leaves its memories (D10): structurally, the memory DDL
    // names no thread column, so no chat delete can cascade to it.
    let s = seeded();
    let sql = s
        .store
        .lock()
        .expect("lock")
        .table_sql("memory")
        .expect("ddl");
    assert!(
        !sql.contains("thread"),
        "no thread FK, nothing to cascade: {sql}"
    );
    call(
        &s.store,
        "t1",
        json!({"command": "create", "path": "/memories/k", "body": "b"}),
    );
    assert!(ok_text(call(
        &s.store,
        "t1",
        json!({"command": "view", "path": "/memories/k"})
    ))
    .contains('b'));
}
