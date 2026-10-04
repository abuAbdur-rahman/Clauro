//! Task 006 — transcript invariants and cancel semantics (RED).
//!
//! I1: every `tool_use` has a `tool_result` with the same id, same thread.
//! I3: `block.generation` non-decreasing along `(thread, seq)`.
//! Cancel: every dispatched call closed as `aborted` (D65), completed work
//! retained (D68), zero orphans after.

use clauro_core::ToolStatus;
use clauro_store::transcript::{OpenCall, PairingReport};
use clauro_store::{
    MessageRole, NewBlock, NewMessage, NewProject, NewThread, NewToolResult, Store,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn fresh() -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("clauro-006-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).expect("scratch dir must be creatable");
        Self { path }
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

fn seeded(dir: &TestDir) -> Store {
    let store = Store::open(&dir.path.join("test.db")).expect("open must succeed");
    store
        .insert_project(NewProject {
            id: "p1".to_string(),
            name: "proj".to_string(),
            instructions: String::new(),
            bash_enabled: false,
        })
        .expect("project");
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
        .expect("thread");
    store
        .insert_message(NewMessage {
            id: "m1".to_string(),
            thread_id: "t1".to_string(),
            seq: 1,
            role: MessageRole::Assistant,
            created_at: now_ms(),
        })
        .expect("message");
    store
}

fn tool_use_block(store: &Store, id: &str, call_id: &str) {
    store
        .insert_block(NewBlock {
            id: id.to_string(),
            message_id: "m1".to_string(),
            seq: 0,
            kind: "tool_use".to_string(),
            payload: format!(r#"{{"id":"{call_id}","name":"fs","input":{{}}}}"#),
            boundary: None,
            is_summary: false,
            generation: 0,
            signature: None,
            dropped: false,
        })
        .expect("tool_use block");
}

fn tool_result(store: &Store, id: &str, call_id: &str, status: ToolStatus) {
    store
        .insert_tool_result(NewToolResult {
            id: id.to_string(),
            thread_id: "t1".to_string(),
            tool_call_id: call_id.to_string(),
            tool_name: "fs".to_string(),
            status,
            preview: "p".to_string(),
            preview_path: None,
            full_path: None,
            output_bytes: 1,
            created_at: now_ms(),
        })
        .expect("tool_result");
}

fn pairing(store: &Store) -> PairingReport {
    let blocks = store.blocks_for_thread("t1");
    let results = store.tool_results_for_thread("t1");
    clauro_store::transcript::find_unpaired_tool_uses(&blocks, &results)
}

// ── I1 ───────────────────────────────────────────────────────────────────────

#[test]
fn paired_turn_passes_i1() {
    let dir = TestDir::fresh();
    let store = seeded(&dir);
    tool_use_block(&store, "b1", "call-1");
    tool_result(&store, "r1", "call-1", ToolStatus::Ok);
    let report = pairing(&store);
    assert!(report.unpaired.is_empty(), "{report:?}");
    assert!(report.malformed.is_empty(), "{report:?}");
}

#[test]
fn orphan_tool_use_fails_i1() {
    let dir = TestDir::fresh();
    let store = seeded(&dir);
    tool_use_block(&store, "b1", "call-9");
    let report = pairing(&store);
    assert_eq!(report.unpaired, vec!["call-9".to_string()]);
}

#[test]
fn malformed_tool_payload_is_reported_not_paired() {
    let dir = TestDir::fresh();
    let store = seeded(&dir);
    store
        .insert_block(NewBlock {
            id: "b-bad".to_string(),
            message_id: "m1".to_string(),
            seq: 0,
            kind: "tool_use".to_string(),
            payload: "not json".to_string(),
            boundary: None,
            is_summary: false,
            generation: 0,
            signature: None,
            dropped: false,
        })
        .expect("malformed block still stores: append-only keeps evidence");
    let report = pairing(&store);
    assert_eq!(report.malformed, vec!["b-bad".to_string()]);
    assert!(report.unpaired.is_empty(), "{report:?}");
}

// ── cancel ───────────────────────────────────────────────────────────────────

#[test]
fn cancel_closes_every_dispatched_call_as_aborted() {
    let dir = TestDir::fresh();
    let store = seeded(&dir);
    tool_use_block(&store, "b1", "call-a");
    tool_use_block(&store, "b2", "call-b");
    tool_use_block(&store, "b3", "call-c");
    tool_result(&store, "r-done", "call-b", ToolStatus::Ok);
    let report = store
        .cancel_turn(
            "t1",
            &[
                OpenCall {
                    id: "call-a".to_string(),
                    name: "fs".to_string(),
                },
                OpenCall {
                    id: "call-b".to_string(),
                    name: "fs".to_string(),
                },
                OpenCall {
                    id: "call-c".to_string(),
                    name: "bash".to_string(),
                },
            ],
        )
        .expect("cancel must succeed");
    assert_eq!(report.aborted, 2, "{report:?}");
    assert_eq!(report.already_resolved, 1, "{report:?}");
    let after = pairing(&store);
    assert!(
        after.unpaired.is_empty(),
        "zero orphans after cancel: {after:?}"
    );
}

#[test]
fn cancel_keeps_completed_work() {
    let dir = TestDir::fresh();
    let store = seeded(&dir);
    tool_use_block(&store, "b1", "call-a");
    tool_result(&store, "r-done", "call-a", ToolStatus::Ok);
    let before = store.blocks_for_thread("t1").len();
    let results_before = store.tool_results_for_thread("t1").len();
    store
        .cancel_turn(
            "t1",
            &[OpenCall {
                id: "call-a".to_string(),
                name: "fs".to_string(),
            }],
        )
        .expect("cancel must succeed");
    assert_eq!(
        store.blocks_for_thread("t1").len(),
        before,
        "no rollback (D68)"
    );
    assert_eq!(
        store.tool_results_for_thread("t1").len(),
        results_before,
        "resolved calls are not rewritten"
    );
}

#[test]
fn aborted_carries_aborted_status() {
    let dir = TestDir::fresh();
    let store = seeded(&dir);
    tool_use_block(&store, "b1", "call-a");
    store
        .cancel_turn(
            "t1",
            &[OpenCall {
                id: "call-a".to_string(),
                name: "fs".to_string(),
            }],
        )
        .expect("cancel must succeed");
    let results = store.tool_results_for_thread("t1");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, ToolStatus::Aborted);
}

// ── thinking ─────────────────────────────────────────────────────────────────

#[test]
fn thinking_signature_survives_store_round_trip() {
    let dir = TestDir::fresh();
    let store = seeded(&dir);
    store
        .insert_block(NewBlock {
            id: "b-think".to_string(),
            message_id: "m1".to_string(),
            seq: 0,
            kind: "thinking".to_string(),
            payload: r#"{"text":"hmm"}"#.to_string(),
            boundary: None,
            is_summary: false,
            generation: 0,
            signature: Some("sig-1".to_string()),
            dropped: false,
        })
        .expect("thinking block");
    let back = store.get_block_full("b-think").expect("must read");
    assert_eq!(back.signature.as_deref(), Some("sig-1"));
    assert_eq!(back.payload, r#"{"text":"hmm"}"#);
}

#[test]
fn generation_break_is_detected_by_position() {
    use clauro_store::transcript::{check_generation_monotonic, FullBlock};
    let mk = |id: &str, generation: i64| FullBlock {
        id: id.to_string(),
        message_seq: 1,
        seq: 0,
        kind: "text".to_string(),
        payload: "{}".to_string(),
        generation,
        signature: None,
    };
    let clean = vec![mk("a", 0), mk("b", 0), mk("c", 1), mk("d", 1)];
    assert_eq!(check_generation_monotonic(&clean), None);
    let broken = vec![mk("a", 1), mk("b", 0)];
    assert_eq!(check_generation_monotonic(&broken), Some(1));
}
