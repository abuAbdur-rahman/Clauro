//! Task 006 — I1/I3 over a transcript fixture corpus (RED).
//!
//! The criterion names "any transcript fixture" but no corpus existed: I1 was
//! checked on three hand-built rows and I3 only on hand-constructed values,
//! never over `blocks_for_thread` output. This file seeds real stores from
//! `tests/fixtures/transcripts/*.json` and runs both checks over the real
//! read path — the corpus, not anecdotes.
//!
//! Two negative fixtures prove the checks bite rather than nod along.

use clauro_store::transcript::{
    check_generation_monotonic, find_unpaired_tool_uses, FullBlock, ToolResultRef,
};
use clauro_store::{MessageRole, NewBlock, NewMessage, NewProject, NewThread, Store};
use serde_json::Value;

#[derive(serde::Deserialize)]
struct FixtureRow {
    role: String,
    kind: String,
    payload: Value,
    generation: i64,
    #[serde(default)]
    signature: Option<String>,
}

fn load_fixture(name: &str) -> Vec<FixtureRow> {
    let path = format!(
        "{}/tests/fixtures/transcripts/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    let bytes = std::fs::read(&path).expect("fixture must read");
    serde_json::from_slice(&bytes).expect("fixture must parse")
}

/// Seed one thread from fixture rows. Consecutive same-role rows share a
/// message; a role change opens a new one. Message and block seqs follow row
/// order, so surface order is the file order.
fn seed(rows: &[FixtureRow]) -> Store {
    let store = Store::open_memory().expect("store");
    store
        .insert_project(NewProject {
            id: "p1".into(),
            name: "P".into(),
            instructions: String::new(),
            bash_enabled: false,
        })
        .expect("project");
    store
        .insert_thread(NewThread {
            id: "t1".to_string(),
            project_id: Some("p1".into()),
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: "h".to_string(),
            tools_frozen: String::new(),
        })
        .expect("thread");
    let mut msg_seq = 0i64;
    let mut msg_id = String::new();
    let mut last_role = String::new();
    let mut block_seq = 0i64;
    for row in rows {
        if row.role != last_role {
            msg_seq += 1;
            msg_id = format!("m{msg_seq}");
            last_role = row.role.clone();
            block_seq = 0;
            let role = match row.role.as_str() {
                "user" => MessageRole::User,
                "system" => MessageRole::System,
                _ => MessageRole::Assistant,
            };
            store
                .insert_message(NewMessage {
                    id: msg_id.clone(),
                    thread_id: "t1".to_string(),
                    seq: msg_seq,
                    role,
                    created_at: 0,
                })
                .expect("message");
        }
        store
            .insert_block(NewBlock {
                id: format!("b{msg_seq}_{block_seq}"),
                message_id: msg_id.clone(),
                seq: block_seq,
                kind: row.kind.clone(),
                payload: serde_json::to_string(&row.payload).expect("payload serializes"),
                boundary: None,
                is_summary: false,
                generation: row.generation,
                signature: row.signature.clone(),
                dropped: false,
            })
            .expect("block");
        block_seq += 1;
    }
    store
}

fn results_of(blocks: &[FullBlock]) -> Vec<ToolResultRef> {
    blocks
        .iter()
        .filter(|b| b.kind == "tool_result")
        .filter_map(|b| {
            serde_json::from_str::<Value>(&b.payload)
                .ok()?
                .get("tool_use_id")?
                .as_str()
                .map(|id| ToolResultRef {
                    tool_call_id: id.to_string(),
                    status: clauro_core::ToolStatus::Ok,
                })
        })
        .collect()
}

/// Every valid fixture in the corpus holds I1 and I3 over the real read.
#[test]
fn valid_fixtures_hold_i1_and_i3() {
    for name in ["basic-turn.json", "multi-turn.json"] {
        let store = seed(&load_fixture(name));
        let blocks = store.blocks_for_thread("t1");
        assert!(!blocks.is_empty(), "{name} must seed rows");
        let report = find_unpaired_tool_uses(&blocks, &results_of(&blocks));
        assert!(
            report.unpaired.is_empty() && report.malformed.is_empty(),
            "{name}: I1 must hold, got {report:?}"
        );
        assert_eq!(
            check_generation_monotonic(&blocks),
            None,
            "{name}: I3 must hold"
        );
    }
}

/// A tool_use without its result is detected, not nodded through.
#[test]
fn broken_pairing_is_detected() {
    let store = seed(&load_fixture("broken-pairing.json"));
    let blocks = store.blocks_for_thread("t1");
    let report = find_unpaired_tool_uses(&blocks, &results_of(&blocks));
    assert_eq!(report.unpaired, vec!["call-x".to_string()]);
}

/// A generation regression is refused at write time with a typed error —
/// stronger than read-time detection: the row never lands.
#[test]
fn generation_regression_is_refused_at_write_time() {
    let rows = load_fixture("generation-regression.json");
    let store = Store::open_memory().expect("store");
    store
        .insert_project(NewProject {
            id: "p1".into(),
            name: "P".into(),
            instructions: String::new(),
            bash_enabled: false,
        })
        .expect("project");
    store
        .insert_thread(NewThread {
            id: "t1".to_string(),
            project_id: Some("p1".into()),
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: "h".to_string(),
            tools_frozen: String::new(),
        })
        .expect("thread");
    store
        .insert_message(NewMessage {
            id: "m1".to_string(),
            thread_id: "t1".to_string(),
            seq: 1,
            role: MessageRole::User,
            created_at: 0,
        })
        .expect("message");
    let first = &rows[0];
    store
        .insert_block(NewBlock {
            id: "b1".to_string(),
            message_id: "m1".to_string(),
            seq: 0,
            kind: first.kind.clone(),
            payload: serde_json::to_string(&first.payload).expect("payload"),
            boundary: None,
            is_summary: false,
            generation: first.generation,
            signature: None,
            dropped: false,
        })
        .expect("generation 1 lands");
    let second = &rows[1];
    let err = store
        .insert_block(NewBlock {
            id: "b2".to_string(),
            message_id: "m1".to_string(),
            seq: 1,
            kind: second.kind.clone(),
            payload: serde_json::to_string(&second.payload).expect("payload"),
            boundary: None,
            is_summary: false,
            generation: second.generation,
            signature: None,
            dropped: false,
        })
        .expect_err("generation 0 after 1 must fail");
    assert!(
        matches!(err, clauro_store::StoreError::GenerationRegression { .. }),
        "typed refusal, never a silent row: {err:?}"
    );
}
