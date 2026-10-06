//! `clauro-tokens`: TokenMeter + CompactionPolicy (Task 015, D82/D25).
//!
//! Pure arithmetic over injected measurement — no provider calls.
//! Formula is D82 (supersedes D64): proportional caps + floor above
//! fixed cost. `request_max_tokens` is this request's `max_tokens`,
//! defaulted to model ceiling only when absent.

use serde::{Deserialize, Serialize};

pub mod compact;

/// Input to trigger computation. All counts tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeterInput {
    pub context_window: u64,
    pub model_max_output: u64,
    pub request_max_tokens: Option<u64>,
    pub headroom_in: u64,
    pub system_tokens: u64,
    pub tool_schema_tokens: u64,
}

/// CONTRACTS.md §4 measurement. Policy never does arithmetic (D25).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Measurement {
    pub input_tokens: u64,
    pub reserved: u64,
    pub headroom_tokens: u64,
    pub usable_tokens: u64,
    pub ratio_bound: u64,
    pub trigger_tokens: u64,
    pub context_window: u64,
}

/// Compaction outcome. `NoProgress` makes D17 enforceable (D63).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompactionResult {
    Committed { generation: u64 },
    Pruned { generation: u64 },
    NoProgress,
}

impl CompactionResult {
    /// Only a generation advance authorises retry (D17/D63).
    #[must_use]
    pub fn authorises_retry(&self) -> bool {
        matches!(self, Self::Committed { .. })
    }
}

/// Policy receives intent, never arithmetic (D25).
pub trait CompactionPolicy {
    fn compact_if_needed(&self, trigger: CompactionTrigger) -> Option<CompactionResult>;
}

/// Intent passed to policy — no token counts cross this boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionTrigger {
    Pressure,
    ContextOverflow,
}

/// D82 trigger. Never panics; absurd inputs clamp via proportional caps.
#[must_use]
pub fn compute_trigger(input: &MeterInput) -> u64 {
    let window = input.context_window.max(1);
    let headroom_cap = ((window as f64) * 0.25) as u64;
    let headroom = input.headroom_in.min(65_536).min(headroom_cap);
    // Absurd request_max saturates here, then capped at 50% window.
    let req = input.request_max_tokens.unwrap_or(input.model_max_output);
    let reserve_cap = ((window as f64) * 0.50) as u64;
    let reserved = req.max(20_000).min(reserve_cap);
    let fixed_cost = input
        .system_tokens
        .saturating_add(input.tool_schema_tokens)
        .saturating_add(512);
    let ratio_bound = ((window as f64) * 0.8) as u64;
    let usable = window.saturating_sub(reserved).saturating_sub(headroom);
    (fixed_cost.saturating_add(2_048)).max(ratio_bound.min(usable))
}

/// Full measurement for a surface of `input_tokens` size.
#[must_use]
pub fn measure(input: &MeterInput, input_tokens: u64) -> Measurement {
    let window = input.context_window.max(1);
    let headroom_cap = ((window as f64) * 0.25) as u64;
    let headroom_tokens = input.headroom_in.min(65_536).min(headroom_cap);
    let reserve_cap = ((window as f64) * 0.50) as u64;
    let req = input.request_max_tokens.unwrap_or(input.model_max_output);
    let reserved = req.max(20_000).min(reserve_cap);
    let ratio_bound = ((window as f64) * 0.8) as u64;
    let usable_tokens = window
        .saturating_sub(reserved)
        .saturating_sub(headroom_tokens);
    let trigger_tokens = compute_trigger(input);
    Measurement {
        input_tokens,
        reserved,
        headroom_tokens,
        usable_tokens,
        ratio_bound,
        trigger_tokens,
        context_window: window,
    }
}
