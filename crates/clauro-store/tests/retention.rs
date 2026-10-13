//! Task 019 failing tests first — delete + fork rows (D10/D99).
//! Real SQLite (tempfile), no mocks. File deletion asserted by caller;
//! here: rows gone, source untouched on fork.

use clauro_store::{
    MessageRole, NewArtifact, NewAttachment, NewBlock, NewCompactionEvent, NewMemory, NewMessage,
    NewProject, NewThread, NewToolResult, NewUsage, Store,
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
    store
        .upsert_memory_setting("t1", true, false)
        .expect("memory setting");
    store.delete_thread("t1").unwrap();
    assert_eq!(store.thread_message_count("t1").unwrap(), 0);
    assert_eq!(store.thread_block_count("t1").unwrap(), 0);
    assert_eq!(store.thread_usage_count("t1").unwrap(), 0);
    assert_eq!(store.thread_tool_result_count("t1").unwrap(), 0);
    assert!(
        store.get_memory_setting("t1").is_none(),
        "the per-thread memory toggle row goes with the thread"
    );
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
fn fork_copies_tool_results_and_the_compaction_ledger() {
    // Review 20, IMPORTANT 7: fork copied only message+block, so every
    // tool_use in the fork was unpaired under I1, and the destination ledger
    // restarted at generation 1 while its blocks claimed N (D84 divergence).
    let store = Store::open_memory().unwrap();
    thread(&store, "src");
    store
        .insert_tool_result(NewToolResult {
            id: "src-tr1".to_string(),
            thread_id: "src".to_string(),
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
    store
        .insert_compaction_event(NewCompactionEvent {
            id: "src-ce1".to_string(),
            thread_id: "src".to_string(),
            generation: 1,
            summary_block: "{}".to_string(),
            covers_from: 0,
            covers_to: 1,
            summary_tokens: 0,
            summary_used_tokens: None,
            created_at: 1,
        })
        .unwrap();
    store.fork_thread("src", "dst").unwrap();
    assert_eq!(
        store.thread_tool_result_count("dst").unwrap(),
        1,
        "tool results must land in the fork or I1 pairing breaks there"
    );
    assert_eq!(
        store
            .compaction_generations("dst")
            .expect("ledger must read"),
        vec![1],
        "the destination ledger continues the source's generations"
    );
    // The source is untouched (D99).
    assert_eq!(store.thread_tool_result_count("src").unwrap(), 1);
    assert_eq!(
        store
            .compaction_generations("src")
            .expect("ledger must read"),
        vec![1]
    );
}

#[test]
fn delete_project_clears_threads_and_memories() {
    // Review 20 NIT: this test claimed "clears memories" but inserted none.
    // Seed the whole project subtree — memory, attachment, per-thread memory
    // setting — and assert every row goes, exercising the FK ordering
    // (attachment REFERENCES project(id), memory_setting REFERENCES
    // thread(id), both with no CASCADE).
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
    store
        .insert_memory(NewMemory {
            id: "mem1".to_string(),
            project_id: Some("p1".to_string()),
            topic: "prefs".to_string(),
            path: "/memories/prefs".to_string(),
            body: "b".to_string(),
            sensitive: false,
            updated_at: 1,
        })
        .unwrap();
    store
        .insert_attachment(NewAttachment {
            id: "att1".to_string(),
            project_id: Some("p1".to_string()),
            path: "uploads/f.png".to_string(),
            content_hash: "hash-p1".to_string(),
            bytes: 3,
            media_type: "image/png".to_string(),
            name: "f.png".to_string(),
            created_at: 1,
        })
        .unwrap();
    store.upsert_memory_setting("pt1", true, false).unwrap();
    store.delete_project("p1").unwrap();
    assert!(store.get_thread("pt1").unwrap().is_none());
    assert!(
        store.list_memories(Some("p1")).unwrap().is_empty(),
        "project-scoped memories go with the project"
    );
    assert!(
        store
            .attachment_path_for_hash(Some("p1"), "hash-p1")
            .is_none(),
        "project attachments go with the project"
    );
    assert!(
        store.get_memory_setting("pt1").is_none(),
        "the thread's memory_setting row goes with its thread"
    );
}

#[test]
fn delete_thread_removes_artifact_and_compaction_rows() {
    // V6 audit CRITICAL: delete_thread skipped `artifact`/`compaction_event`
    // (both REFERENCES thread(id), no CASCADE) and ran 6 DELETEs with no
    // transaction — an artifact-bearing thread destroyed its history then
    // failed FK forever. Fix: children first, one transaction.
    let store = Store::open_memory().unwrap();
    thread(&store, "t1");
    store
        .insert_artifact_version(
            &NewArtifact {
                id: "art-1".to_string(),
                thread_id: "t1".to_string(),
                title: "demo".to_string(),
                media_type: "text/html".to_string(),
                source_path: "artifacts/art-1-1/source".to_string(),
                created_at: 1,
            },
            1,
        )
        .unwrap();
    store
        .insert_compaction_event(NewCompactionEvent {
            id: "ce-1".to_string(),
            thread_id: "t1".to_string(),
            generation: 1,
            summary_block: "{}".to_string(),
            covers_from: 0,
            covers_to: 1,
            summary_tokens: 0,
            summary_used_tokens: None,
            created_at: 1,
        })
        .unwrap();
    // Must not error on FK (thread row goes last), must not leave orphans.
    store.delete_thread("t1").unwrap();
    assert_eq!(store.thread_artifact_count("t1").unwrap(), 0);
    assert_eq!(store.thread_compaction_count("t1").unwrap(), 0);
    assert!(store.get_thread("t1").unwrap().is_none());
    assert_eq!(store.thread_message_count("t1").unwrap(), 0);
}

#[test]
fn delete_project_removes_artifact_bearing_threads() {
    // V6 audit CRITICAL: delete_project ran its artifact DELETE *after* the
    // thread loop → dead code exactly when it mattered; compaction_event never
    // deleted anywhere. A project with any artifact-bearing thread could never
    // be deleted. Fix: children inside the same transaction as the thread loop.
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
    store
        .insert_artifact_version(
            &NewArtifact {
                id: "art-1".to_string(),
                thread_id: "pt1".to_string(),
                title: "demo".to_string(),
                media_type: "text/html".to_string(),
                source_path: "artifacts/art-1-1/source".to_string(),
                created_at: 1,
            },
            1,
        )
        .unwrap();
    store
        .insert_compaction_event(NewCompactionEvent {
            id: "ce-1".to_string(),
            thread_id: "pt1".to_string(),
            generation: 1,
            summary_block: "{}".to_string(),
            covers_from: 0,
            covers_to: 1,
            summary_tokens: 0,
            summary_used_tokens: None,
            created_at: 1,
        })
        .unwrap();
    store.delete_project("p1").unwrap();
    assert!(store.get_thread("pt1").unwrap().is_none());
    assert_eq!(store.thread_artifact_count("pt1").unwrap(), 0);
    assert_eq!(store.thread_compaction_count("pt1").unwrap(), 0);
    assert!(store.get_project("p1").unwrap().is_none());
}
