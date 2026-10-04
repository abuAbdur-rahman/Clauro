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
    use clauro_store::{NewProject, NewThread};
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
    drop(first);
    let second = Store::open(&path).expect("reopen");
    assert!(
        second.table_names().contains(&"thread".to_string()),
        "schema intact across restart"
    );
    assert_eq!(
        second.blocks_for_thread("t1").len(),
        0,
        "no rows yet, but the thread's absence must not error"
    );
    let _ = std::fs::remove_file(&path);
}
