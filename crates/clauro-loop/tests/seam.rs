//! Task 006 — transcript rows crossing the Tauri seam (RED).
//!
//! The store keeps blocks as `(kind, payload JSON, signature, generation)`.
//! `CONTRACTS.md` §2 defines what a view renders: a discriminated
//! `ContentBlock` union, one shape for both providers (D54). Something has to
//! translate between them, and until it exists the frontend has no shape to
//! render and the renderer can only be tested against a shape it invented.
//!
//! What is pinned here:
//! - every stored `kind` maps to exactly one contract variant;
//! - `tool_use` keeps its id and name so I1 pairing survives the seam;
//! - `tool_result` carries `status` and `previewPath` (D27) — the model must be
//!   able to re-read the full text, so a bounded preview without its path is a
//!   data-loss bug in the view;
//! - a **malformed payload degrades to a notice, never a panic** (`D55`): a
//!   corrupt row must be visible in the transcript, not fatal to reading it;
//! - `generation` rides along, so I3 is checkable from the view side.

use clauro_core::{ContentBlock, NoticeLevel, ThinkingDisplay, ToolStatus};
use clauro_store::{NewMessage, Store};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn fresh() -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("clauro-006-seam-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).expect("scratch");
        Self(p)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Seed one message carrying the given `(kind, payload, signature)` rows.
fn seed(store: &Store, thread: &str, rows: &[(&str, &str, Option<&str>)]) {
    // The message row carries a thread foreign key, so the thread must exist
    // before the message does.
    store
        .insert_thread(clauro_store::NewThread {
            id: thread.to_string(),
            project_id: None,
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: "h".to_string(),
            tools_frozen: String::new(),
        })
        .expect("thread");
    let msg = "m1".to_string();
    store
        .insert_message(NewMessage {
            id: msg.clone(),
            thread_id: thread.to_string(),
            seq: 1,
            role: clauro_store::MessageRole::Assistant,
            created_at: 0,
        })
        .expect("message");
    for (i, (kind, payload, signature)) in rows.iter().enumerate() {
        store
            .insert_block(clauro_store::NewBlock {
                id: format!("b{i}"),
                message_id: msg.clone(),
                seq: i as i64,
                kind: (*kind).to_string(),
                payload: (*payload).to_string(),
                boundary: None,
                is_summary: false,
                generation: 0,
                signature: signature.map(str::to_string),
                dropped: false,
            })
            .expect("block");
    }
}

fn one(kind: &str, payload: &str) -> Store {
    let _dir = TestDir::fresh();
    let store = Store::open_memory().expect("store");
    seed(&store, "t1", &[(kind, payload, None)]);
    store
}

/// A text row becomes a `text` block with its text intact.
#[test]
fn text_row_becomes_a_text_block() {
    let store = one("text", r#"{"text":"hello"}"#);
    let out = clauro_loop::blocks_to_contract(&store.blocks_for_thread("t1"));
    assert_eq!(out.len(), 1);
    match &out[0].block {
        ContentBlock::Text { text } => assert_eq!(text, "hello"),
        other => panic!("expected text, got {other:?}"),
    }
    assert_eq!(out[0].role, "assistant");
    assert_eq!(out[0].generation, 0);
}

/// Thinking keeps its signature: without it the block is not re-sendable and
/// the prefix check fails on the next turn (D72).
#[test]
fn thinking_row_keeps_its_signature() {
    let dir = TestDir::fresh();
    let store = Store::open_memory().expect("store");
    seed(
        &store,
        "t1",
        &[(
            "thinking",
            r#"{"text":"pondering","display":"full"}"#,
            Some("sig-abc"),
        )],
    );
    let out = clauro_loop::blocks_to_contract(&store.blocks_for_thread("t1"));
    match &out[0].block {
        ContentBlock::Thinking {
            text,
            signature,
            display,
        } => {
            assert_eq!(text, "pondering");
            assert_eq!(signature, "sig-abc");
            assert_eq!(display, &ThinkingDisplay::Full);
        }
        other => panic!("expected thinking, got {other:?}"),
    }
    drop(dir);
}

/// A tool_use keeps id + name so I1 pairing survives the seam.
#[test]
fn tool_use_row_keeps_its_id_and_name() {
    let store = one("tool_use", r#"{"id":"call-1","name":"fs","input":"{}"}"#);
    let out = clauro_loop::blocks_to_contract(&store.blocks_for_thread("t1"));
    match &out[0].block {
        ContentBlock::ToolUse { id, name, .. } => {
            assert_eq!(id, "call-1");
            assert_eq!(name, "fs");
        }
        other => panic!("expected tool_use, got {other:?}"),
    }
}

/// A tool_result keeps status AND previewPath (D27). A bounded preview without
/// the path is the data-loss bug: the model could never re-read the full text.
#[test]
fn tool_result_row_carries_status_and_preview_path() {
    let store = one(
        "tool_result",
        r#"{"tool_use_id":"call-1","status":"ok","preview":"first 400 bytes","preview_path":"C:/w/p.txt"}"#,
    );
    let out = clauro_loop::blocks_to_contract(&store.blocks_for_thread("t1"));
    match &out[0].block {
        ContentBlock::ToolResult {
            tool_use_id,
            status,
            preview,
            preview_path,
        } => {
            assert_eq!(tool_use_id, "call-1");
            assert_eq!(*status, ToolStatus::Ok);
            assert_eq!(preview, "first 400 bytes");
            assert_eq!(
                preview_path.as_deref(),
                Some("C:/w/p.txt"),
                "the path the model re-reads from must survive the seam"
            );
        }
        other => panic!("expected tool_result, got {other:?}"),
    }
}

/// Every `aborted` / `rejected` status must survive distinctly — DESIGN.md §2.2
/// requires all four to be visually distinct, and nothing reads as a crash.
#[test]
fn every_tool_result_status_survives_distinctly() {
    for (wire, expected) in [
        ("ok", ToolStatus::Ok),
        ("error", ToolStatus::Error),
        ("aborted", ToolStatus::Aborted),
        ("rejected", ToolStatus::Rejected),
    ] {
        let store = one(
            "tool_result",
            &format!(r#"{{"tool_use_id":"c","status":"{wire}","preview":""}}"#),
        );
        let out = clauro_loop::blocks_to_contract(&store.blocks_for_thread("t1"));
        match &out[0].block {
            ContentBlock::ToolResult { status, .. } => assert_eq!(
                *status, expected,
                "{wire} must not collapse into another status"
            ),
            other => panic!("expected tool_result, got {other:?}"),
        }
    }
}

/// A corrupt payload becomes a visible notice, never a panic (D55). A row the
/// app cannot parse must still be renderable — silently dropping it would
/// render a plausible-looking wrong transcript.
#[test]
fn a_malformed_payload_degrades_to_a_notice() {
    let store = one("text", "{not json at all");
    let out = clauro_loop::blocks_to_contract(&store.blocks_for_thread("t1"));
    assert_eq!(out.len(), 1, "the row is still surfaced");
    match &out[0].block {
        ContentBlock::Notice { level, text } => {
            assert_eq!(*level, NoticeLevel::Warn);
            assert_eq!(*level, NoticeLevel::Warn);
            assert!(
                text.contains("b0") && text.contains("text"),
                "the notice names the row id and kind so it can be found: {text}"
            );
            assert!(
                !text.contains("not json"),
                "the raw payload is not echoed into the transcript: {text}"
            );
        }
        other => panic!("expected a notice, got {other:?}"),
    }
}

/// A kind this build does not know is a notice, not a drop. A newer store must
/// never make an older view silently lose rows.
#[test]
fn an_unknown_kind_degrades_to_a_notice() {
    let store = one("some_future_block", "{}");
    let out = clauro_loop::blocks_to_contract(&store.blocks_for_thread("t1"));
    match &out[0].block {
        ContentBlock::Notice { text, .. } => {
            assert!(text.contains("some_future_block"), "names the kind: {text}")
        }
        other => panic!("expected a notice, got {other:?}"),
    }
}

/// Surface order is `(message seq, block seq)` — the store's order, unchanged.
#[test]
fn rows_keep_store_order() {
    let dir = TestDir::fresh();
    let store = Store::open_memory().expect("store");
    seed(
        &store,
        "t1",
        &[
            ("text", r#"{"text":"first"}"#, None),
            ("text", r#"{"text":"second"}"#, None),
        ],
    );
    let out = clauro_loop::blocks_to_contract(&store.blocks_for_thread("t1"));
    let texts: Vec<&str> = out
        .iter()
        .filter_map(|r| match &r.block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["first", "second"]);
    drop(dir);
}
