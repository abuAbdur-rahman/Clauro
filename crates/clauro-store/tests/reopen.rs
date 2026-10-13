//! CodeRabbit PR #3 finding (Critical): reopening must work (RED).
//!
//! `Store::open` ran the schema DDL on every open, so the second open of the
//! same file failed with "table project already exists". The app must survive
//! its own restart.

use clauro_store::Store;
use std::path::PathBuf;

#[test]
fn reopening_the_same_file_succeeds() {
    let path: PathBuf = std::env::temp_dir().join(format!(
        "clauro-reopen-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    Store::open(&path).expect("first open creates");
    Store::open(&path).expect("second open reopens: the file outlives any handle");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn reopened_store_keeps_prior_rows() {
    use clauro_store::{MessageRole, NewBlock, NewMessage, NewProject, NewThread};
    let path: PathBuf = std::env::temp_dir().join(format!(
        "clauro-reopen2-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let first = Store::open(&path).expect("first open");
    first
        .insert_project(NewProject {
            id: "p1".to_string(),
            name: "proj".to_string(),
            instructions: String::new(),
            bash_enabled: false,
        })
        .expect("seed");
    first
        .insert_thread(NewThread {
            id: "t1".to_string(),
            project_id: Some("p1".to_string()),
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: "s".to_string(),
            tools_frozen: "[]".to_string(),
        })
        .expect("seed");
    first
        .insert_message(NewMessage {
            id: "m1".to_string(),
            thread_id: "t1".to_string(),
            seq: 1,
            role: MessageRole::User,
            created_at: 1,
        })
        .expect("seed");
    first
        .insert_block(NewBlock {
            id: "b1".to_string(),
            message_id: "m1".to_string(),
            seq: 0,
            kind: "text".to_string(),
            payload: r#"{"text":"persisted"}"#.to_string(),
            boundary: None,
            is_summary: false,
            generation: 0,
            signature: None,
            dropped: false,
        })
        .expect("seed");
    drop(first);
    let second = Store::open(&path).expect("reopen");
    assert!(
        second.table_names().contains(&"thread".to_string()),
        "schema intact across restart"
    );
    // Review 20 NIT: the reopen test asserted schema and absence only. The
    // seeded rows must read back through the same paths the app uses.
    assert_eq!(
        second.get_project("p1").expect("read").as_deref(),
        Some("proj"),
        "project row survives the restart"
    );
    let thread = second
        .get_thread("t1")
        .expect("read")
        .expect("thread row survives the restart");
    assert_eq!(thread.system_frozen, "s");
    let blocks = second.blocks_for_thread("t1");
    assert_eq!(blocks.len(), 1, "the seeded block reads back");
    assert_eq!(blocks[0].payload, r#"{"text":"persisted"}"#);
    assert_eq!(
        second.blocks_for_thread("t-never-used").len(),
        0,
        "an absent thread reads empty, not an error"
    );
    let _ = std::fs::remove_file(&path);
}
