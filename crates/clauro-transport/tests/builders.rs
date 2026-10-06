//! Task 005 — request builders: the XOR is structural (RED).
//!
//! `compaction` and `context_management` cannot share one request (D21, a hard
//! 400). Two builders returning two shapes makes the combination
//! unrepresentable, not merely untested. D74's compaction constraints (no
//! `stop_sequences`, no `any`/`tool` choice) fall out the same way: the
//! compaction builder has no such fields.

use clauro_transport::{
    build_compaction_request, build_normal_request, CompactionBuildInput, NormalBuildInput,
    ThinkingConfig,
};
use serde_json::json;

#[test]
fn normal_request_carries_binding_on_its_path_with_beta_header() {
    let built = build_normal_request(NormalBuildInput {
        model: "claude-x".to_string(),
        max_tokens: 1024,
        system: "sys".to_string(),
        messages: vec![],
        tools: vec![],
        thinking: ThinkingConfig {
            budget_tokens: 10_000,
            display: None,
        },
        tool_choice: json!({"type": "auto"}),
    });
    assert_eq!(
        built.body["thinking"]["block_binding"]["prefix_mismatch_behavior"],
        json!("drop_block"),
        "nested path, never top-level (D20)"
    );
    assert!(
        built
            .headers
            .iter()
            .any(|(k, v)| k == "anthropic-beta"
                && v.contains("thinking-binding-controls-2026-08-01")),
        "beta header required or the nested field 400s (D20): {:?}",
        built.headers
    );
    assert!(
        built.body.get("context_management").is_some(),
        "normal requests carry context_management edits (D21)"
    );
    assert!(
        built.body.get("compaction").is_none(),
        "a normal request must not carry compaction (D21)"
    );
}

#[test]
fn compaction_request_is_structurally_exclusive() {
    let built = build_compaction_request(CompactionBuildInput {
        model: "claude-x".to_string(),
        max_tokens: 4096,
        messages: vec![json!({"role": "user", "content": "hi"})],
        instructions: None,
    })
    .expect("short instructions build");
    assert!(
        built.body.get("compaction").is_some(),
        "compaction requests carry compaction"
    );
    for banned in ["context_management", "stop_sequences", "tool_choice"] {
        assert!(
            built.body.get(banned).is_none(),
            "{banned} on a compaction request is a 400 (D21, D74): {}",
            built.body
        );
    }
}

#[test]
fn compaction_instructions_pass_through_capped() {
    let long = "x".repeat(20_000);
    let err = build_compaction_request(CompactionBuildInput {
        model: "claude-x".to_string(),
        max_tokens: 4096,
        messages: vec![],
        instructions: Some(long),
    })
    .expect_err("overlong must reject client-side (D75)");
    assert!(
        err.to_string().contains("16,384"),
        "clear error, got: {err}"
    );
    let ok = build_compaction_request(CompactionBuildInput {
        model: "claude-x".to_string(),
        max_tokens: 4096,
        messages: vec![],
        instructions: Some("x".repeat(100)),
    })
    .expect("short builds");
    assert_eq!(
        ok.body["compaction"]["instructions"]
            .as_str()
            .expect("serialise")
            .len(),
        100
    );
}
