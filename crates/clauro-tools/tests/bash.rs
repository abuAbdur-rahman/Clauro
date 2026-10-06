//! Task 012 — bash consent, mapping, and honesty (RED).
//!
//! Off by default per project; every invocation approved, nothing persisted.
//! Reject is `rejected` (CONTRACTS §3 beats D109's loose "error" wording).
//! Non-zero exits are `ok` with output. The model tool has no `stdin`/`env`.

use clauro_core::{Effect, ToolOutcome};
use clauro_tools::{bash_ask_rule, granted_with_bash, register_bash};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn ctx() -> clauro_core::ToolContext {
    clauro_core::ToolContext {
        thread_id: "t1".to_string(),
        call_id: "c1".to_string(),
        workspace_dir: PathBuf::from("/tmp/ws"),
    }
}

#[test]
fn ask_rule_is_ask_for_bash_and_nothing_persists() {
    let rule = bash_ask_rule();
    assert_eq!(rule.tool, "bash");
    assert_eq!(rule.effect, Effect::Ask);
    // A second call returns the same rule: computed, never stored.
    assert_eq!(bash_ask_rule(), rule);
}

#[test]
fn opt_in_maps_project_flag_to_granted_set() {
    let on = granted_with_bash(&["fs"], true);
    assert!(on.iter().any(|t| t == "bash"));
    assert!(on.iter().any(|t| t == "fs"));
    let off = granted_with_bash(&["fs"], false);
    assert!(!off.iter().any(|t| t == "bash"));
}

#[test]
fn schema_has_no_stdin_or_env() {
    let def = clauro_tools::eight_definitions()
        .into_iter()
        .find(|d| d.name == "bash")
        .expect("bash defined");
    let props = def.input_schema.get("properties").expect("properties");
    assert!(props.get("stdin").is_none(), "no stdin (D29)");
    assert!(props.get("env").is_none(), "no env (D29)");
    assert!(props.get("command").is_some());
}

#[test]
fn nonzero_exit_is_ok_with_output_attached() {
    let dir = std::env::temp_dir().join(format!("clauro-012b-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch");
    let store = Arc::new(Mutex::new(
        clauro_store::Store::open(&dir.join("t.db")).expect("db"),
    ));
    let host = Arc::new(clauro_tools::FsHost::new(&dir, &dir, None, store).expect("host"));
    let mut reg = clauro_tools::Registry::with_eight();
    register_bash(&mut reg, host);
    let m = reg.materialize();
    #[cfg(windows)]
    let cmd = "echo out-text & exit 3";
    #[cfg(not(windows))]
    let cmd = "echo out-text; exit 3";
    let out = reg.dispatch(
        &clauro_tools::IncomingCall {
            name: "bash".to_string(),
            input: serde_json::json!({"command": cmd}),
            epoch: m.epoch,
        },
        &ctx(),
    );
    match out {
        ToolOutcome::Ok { preview, .. } => {
            assert!(preview.contains("out-text"), "{preview}");
            assert!(preview.contains('3'), "exit code attached: {preview}");
        }
        other => panic!("non-zero is ok (D55): {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rejected_is_rejected_status() {
    let mut q = clauro_tools::ApprovalQueue::new();
    q.hold("h1", "bash", serde_json::json!({}));
    q.mark_pending("h1").expect("pending");
    let outcome = q.reject("h1").expect("reject");
    assert!(
        matches!(outcome, ToolOutcome::Rejected { .. }),
        "declined commands are rejected results (D66): {outcome:?}"
    );
}
