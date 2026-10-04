//! Request builders: the D21 XOR is structural.
//!
//! `compaction` and `context_management` cannot share one request (a hard
//! 400), so there is no single builder with two optional fields. Two input
//! shapes, two functions, two serialised bodies — the combination is
//! unrepresentable, not merely untested. D74's compaction constraints fall out
//! the same way: the compaction input has no `stop_sequences`, no
//! `tool_choice`, and no context-management edits to set.
//!
//! Wire-shape honesty: the `thinking.block_binding` path, the beta header,
//! and the two beta edit names are pinned by D20/D21. The exact
//! `context_management` trigger payload is trigger tuning that lands with 017
//! (`clear_at_least`, D86); what matters here is which parameter rides which
//! request.

use serde_json::{json, Value};

/// Beta header gating the block-binding controls (D20).
pub const THINKING_BINDING_BETA: &str = "thinking-binding-controls-2026-08-01";

/// Server-side instruction budget for on-demand compaction (D75).
pub const MAX_COMPACTION_INSTRUCTIONS: usize = 16_384;

/// Thinking effort, already resolved to a token budget by the composer: the
/// effort slider is a UI knob, the wire takes a number.
pub struct ThinkingConfig {
    pub budget_tokens: u32,
    pub display: Option<String>,
}

/// Everything a normal (non-compaction) Anthropic request needs.
pub struct NormalBuildInput {
    pub model: String,
    pub max_tokens: u32,
    pub system: String,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    pub thinking: ThinkingConfig,
    pub tool_choice: Value,
}

/// Everything an on-demand compaction request needs — and nothing it must
/// not carry (D74).
pub struct CompactionBuildInput {
    pub model: String,
    pub max_tokens: u32,
    pub messages: Vec<Value>,
    pub instructions: Option<String>,
}

/// Headers plus the serialised body, ready for the HTTP layer (006).
pub struct BuiltRequest {
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

/// A normal request: `context_management` edits ride along, `compaction` is
/// absent by construction (D21). `prefix_mismatch_behavior` sits at
/// `thinking.block_binding`, never top-level, with its beta header (D20).
pub fn build_normal_request(input: NormalBuildInput) -> BuiltRequest {
    let mut thinking = json!({
        "type": "enabled",
        "budget_tokens": input.thinking.budget_tokens,
        "block_binding": {"prefix_mismatch_behavior": "drop_block"},
    });
    if let Some(display) = input.thinking.display {
        thinking["display"] = Value::String(display);
    }
    BuiltRequest {
        headers: vec![(
            "anthropic-beta".to_string(),
            THINKING_BINDING_BETA.to_string(),
        )],
        body: json!({
            "model": input.model,
            "max_tokens": input.max_tokens,
            "system": input.system,
            "messages": input.messages,
            "tools": input.tools,
            "tool_choice": input.tool_choice,
            "thinking": thinking,
            // clear_thinking_20251015 first (D21). Trigger payload tuned in 017.
            "context_management": {"edits": [
                {"type": "clear_thinking_20251015"},
                {"type": "clear_tool_uses_20250919"},
            ]},
        }),
    }
}

/// An on-demand compaction request: `compaction` rides along, everything else
/// is absent by construction (D21, D74).
pub fn build_compaction_request(input: CompactionBuildInput) -> BuiltRequest {
    let instructions = input.instructions.unwrap_or_default();
    let capped: String = instructions
        .chars()
        .take(MAX_COMPACTION_INSTRUCTIONS)
        .collect();
    BuiltRequest {
        headers: vec![(
            "anthropic-beta".to_string(),
            THINKING_BINDING_BETA.to_string(),
        )],
        body: json!({
            "model": input.model,
            "max_tokens": input.max_tokens,
            "messages": input.messages,
            "compaction": {"type": "auto", "instructions": capped},
        }),
    }
}
