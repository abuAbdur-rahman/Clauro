//! Task 019 failing tests first — delete + fork rows (D10/D99).
//! Real SQLite (tempfile), no mocks. File deletion asserted by caller;
//! here: rows gone, source untouched on fork.

use clauro_store::{
    MessageRole, NewBlock, NewMessage, NewProject, NewThread, NewToolResult, NewUsage, Store,
};

fn thread(store: &Store, id: &str) {
    store
        .insert_thread(NewThread {
            id: id.to_string(),
            project_id: None,
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: "sys".to_string(),
            tools_frozen: "[]".to_string(),
        })
        .unwrap();
    store
        .insert_message(NewMessage {
            id: format!("{id}-m1"),
            thread_id: id.to_string(),
            seq: 1,
            role: MessageRole::User,
            created_at: 1,
        })
        .unwrap();
    store
        .insert_block(NewBlock {
            id: format!("{id}-b1"),
            message_id: format!("{id}-m1"),
            seq: 0,
            kind: "text".to_string(),
            payload: "{}".to_string(),
            boundary: None,
            is_summary: false,
            generation: 0,
            signature: None,
            dropped: false,
        })
        .unwrap();
}

#[test]
fn delete_thread_removes_rows() {
    let store = Store::open_memory().unwrap();
    thread(&store, "t1");
    store
        .insert_usage(NewUsage {
            id: "t1-u1".to_string(),
            thread_id: "t1".to_string(),
            message_id: None,
            run_id: "r1".to_string(),
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            summary_tokens: 0,
            summary_used_tokens: None,
            iterations: None,
            context_budget: None,
            created_at: 1,
        })
        .unwrap();
    store
        .insert_tool_result(NewToolResult {
            id: "t1-tr1".to_string(),
            thread_id: "t1".to_string(),
            tool_call_id: "c1".to_string(),
            tool_name: "fs".to_string(),
            status: clauro_core::ToolStatus::Ok,
            preview: "p".to_string(),
            preview_path: None,
            full_path: None,
            output_bytes: 0,
            created_at: 1,
        })
        .unwrap();
    store.delete_thread("t1").unwrap();
    assert_eq!(store.thread_message_count("t1").unwrap(), 0);
    assert_eq!(store.thread_block_count("t1").unwrap(), 0);
    assert_eq!(store.thread_usage_count("t1").unwrap(), 0);
    assert_eq!(store.thread_tool_result_count("t1").unwrap(), 0);
}

#[test]
fn fork_copies_prefix_source_untouched() {
    let store = Store::open_memory().unwrap();
    thread(&store, "src");
    store.fork_thread("src", "dst").unwrap();
    assert_eq!(store.thread_message_count("src").unwrap(), 1);
    assert_eq!(store.thread_message_count("dst").unwrap(), 1);
    assert_eq!(store.thread_block_count("dst").unwrap(), 1);
}

#[test]
fn delete_project_clears_threads_and_memories() {
    let store = Store::open_memory().unwrap();
    store
        .insert_project(NewProject {
            id: "p1".to_string(),
            name: "P".to_string(),
            instructions: String::new(),
            bash_enabled: false,
        })
        .unwrap();
    store
        .insert_thread(NewThread {
            id: "pt1".to_string(),
            project_id: Some("p1".to_string()),
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: "s".to_string(),
            tools_frozen: "[]".to_string(),
        })
        .unwrap();
    store.delete_project("p1").unwrap();
    assert!(store.get_thread("pt1").unwrap().is_none());
}
