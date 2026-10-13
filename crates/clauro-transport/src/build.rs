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
use std::fmt;

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
#[derive(Debug)]
pub struct BuiltRequest {
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

/// A normal request: `context_management` edits ride along, `compaction` is
/// absent by construction (D21). `prefix_mismatch_behavior` sits at
/// `thinking.block_binding`, never top-level, with its beta header (D20).
///
/// Note: this infallible builder does not validate the thinking budget
/// against `max_tokens` — Anthropic hard-400s `budget_tokens >= max_tokens`.
/// Prefer [`try_build_normal_request`], which rejects the pair client-side.
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

/// Checked variant of [`build_normal_request`]: Anthropic hard-400s a
/// `thinking.budget_tokens` that is not strictly below `max_tokens`, so the
/// pair is rejected here with a clear typed error (audit 12).
pub fn try_build_normal_request(input: NormalBuildInput) -> Result<BuiltRequest, NormalBuildError> {
    if input.thinking.budget_tokens >= input.max_tokens {
        return Err(NormalBuildError::BudgetNotBelowMax {
            budget_tokens: input.thinking.budget_tokens,
            max_tokens: input.max_tokens,
        });
    }
    Ok(build_normal_request(input))
}

/// Overlong-budget rejection (Anthropic hard 400).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalBuildError {
    BudgetNotBelowMax { budget_tokens: u32, max_tokens: u32 },
}

impl fmt::Display for NormalBuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BudgetNotBelowMax {
                budget_tokens,
                max_tokens,
            } => write!(
                f,
                "thinking budget_tokens {budget_tokens} must be below max_tokens {max_tokens} (Anthropic hard 400)"
            ),
        }
    }
}

impl std::error::Error for NormalBuildError {}

/// An on-demand compaction request: `compaction` rides along, everything else
/// is absent by construction (D21, D74). Overlong instructions are rejected
/// client-side with a clear error, never sent to 400 (D75).
pub fn build_compaction_request(
    input: CompactionBuildInput,
) -> Result<BuiltRequest, CompactionBuildError> {
    let instructions = input.instructions.unwrap_or_default();
    if instructions.chars().count() > MAX_COMPACTION_INSTRUCTIONS {
        return Err(CompactionBuildError::InstructionsTooLong {
            got: instructions.chars().count(),
        });
    }
    Ok(BuiltRequest {
        headers: vec![(
            "anthropic-beta".to_string(),
            THINKING_BINDING_BETA.to_string(),
        )],
        body: json!({
            "model": input.model,
            "max_tokens": input.max_tokens,
            "messages": input.messages,
            "compaction": {"type": "auto", "instructions": instructions},
        }),
    })
}

/// Swap-protocol guard, validated before sending (D69): block first,
/// exactly one, summarised messages removed by caller.
pub fn validate_compaction_swap(
    block_first: bool,
    block_count: usize,
) -> Result<(), CompactionSwapError> {
    if !block_first {
        return Err(CompactionSwapError::NotFirst);
    }
    if block_count != 1 {
        return Err(CompactionSwapError::Count { got: block_count });
    }
    Ok(())
}

/// Overlong-instruction rejection (D75).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactionBuildError {
    InstructionsTooLong { got: usize },
}

impl fmt::Display for CompactionBuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InstructionsTooLong { got } => write!(
                f,
                "compaction instructions {got} chars exceed server cap 16,384 (D75)"
            ),
        }
    }
}

impl std::error::Error for CompactionBuildError {}

/// Silent-corruption guard (D69): two failure modes raise no error server-side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactionSwapError {
    NotFirst,
    Count { got: usize },
}

impl fmt::Display for CompactionSwapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFirst => write!(f, "compaction block must be first in messages (D69)"),
            Self::Count { got } => write!(
                f,
                "exactly one compaction block per request, got {got} (D69)"
            ),
        }
    }
}

impl std::error::Error for CompactionSwapError {}
