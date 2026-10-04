//! Task 006 — effort may vary mid-thread (RED).
//!
//! Thinking effort, `max_tokens`, `tool_choice` and friends are outside the
//! prefix freeze (D19 constrains `system` and `tools` only, D76). Two
//! consecutive requests with different budgets must both build, carrying
//! their own values.

use clauro_transport::{build_normal_request, NormalBuildInput, ThinkingConfig};
use serde_json::json;

fn build_with_budget(budget: u32) -> serde_json::Value {
    build_normal_request(NormalBuildInput {
        model: "claude-x".to_string(),
        max_tokens: 1024,
        system: "sys".to_string(),
        messages: vec![],
        tools: vec![],
        thinking: ThinkingConfig {
            budget_tokens: budget,
            display: None,
        },
        tool_choice: json!({"type": "auto"}),
    })
    .body
}

#[test]
fn effort_changes_do_not_error_and_stick_to_their_request() {
    let low = build_with_budget(1_024);
    let high = build_with_budget(10_000);
    assert_eq!(low["thinking"]["budget_tokens"], json!(1_024));
    assert_eq!(high["thinking"]["budget_tokens"], json!(10_000));
    // Same frozen surface otherwise: system/tools handling untouched.
    assert_eq!(low["model"], high["model"]);
}
