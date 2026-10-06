//! Task 017 failing tests first — Anthropic paths (D21/D69/D75/D81/D95).
//!
//! Branch order is on-demand-first per D95 (newest docs); SPEC M5 saying
//! threshold-preferred is stale and recorded as such.

use clauro_transport::{
    build_compaction_request, build_normal_request, select_compaction_path,
    validate_compaction_swap, CompactionBuildInput, CompactionPath, NormalBuildInput,
    ThinkingConfig,
};
use serde_json::json;

fn normal_input() -> NormalBuildInput {
    NormalBuildInput {
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
    }
}

#[test]
fn capability_selects_path_no_key() {
    assert_eq!(
        select_compaction_path(CompactionPath::OnDemand),
        CompactionPath::OnDemand
    );
    assert_eq!(
        select_compaction_path(CompactionPath::Threshold),
        CompactionPath::Threshold
    );
    assert_eq!(
        select_compaction_path(CompactionPath::None),
        CompactionPath::None
    );
}

#[test]
fn on_demand_is_primary_when_available() {
    // D95: use on-demand wherever available — no preference ordering in code,
    // capability probe decides.
    let model = json!({"capabilities": {"compaction": "on-demand"}});
    assert_eq!(
        clauro_transport::compaction_path(&model),
        CompactionPath::OnDemand
    );
}

#[test]
fn xor_holds_on_every_branch() {
    let n = build_normal_request(normal_input());
    assert!(n.body.get("context_management").is_some());
    assert!(n.body.get("compaction").is_none());
    let c = build_compaction_request(CompactionBuildInput {
        model: "m".to_string(),
        max_tokens: 1024,
        messages: vec![],
        instructions: Some("checkpoint".to_string()),
    })
    .expect("short instructions build");
    assert!(c.body.get("compaction").is_some());
    assert!(c.body.get("context_management").is_none());
}

#[test]
fn overlong_instructions_rejected_client_side() {
    let long = "x".repeat(16_385);
    let err = build_compaction_request(CompactionBuildInput {
        model: "m".to_string(),
        max_tokens: 1024,
        messages: vec![],
        instructions: Some(long),
    })
    .expect_err("must reject >16384 client-side, not send and 400");
    assert!(
        err.to_string().contains("16,384"),
        "clear error, got: {err}"
    );
}

#[test]
fn swap_validated_block_first_exactly_one() {
    assert!(validate_compaction_swap(true, 1).is_ok());
    assert!(validate_compaction_swap(false, 1).is_err());
    assert!(validate_compaction_swap(true, 2).is_err());
    assert!(validate_compaction_swap(true, 0).is_err());
}

#[test]
fn thinking_clear_serialised_first() {
    let n = build_normal_request(normal_input());
    let edits = n.body["context_management"]["edits"]
        .as_array()
        .expect("edits");
    assert_eq!(edits[0]["type"], json!("clear_thinking_20251015"));
    assert_eq!(edits[1]["type"], json!("clear_tool_uses_20250919"));
}
