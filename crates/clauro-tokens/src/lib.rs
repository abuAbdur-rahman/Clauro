//! `clauro-tokens`: TokenMeter + CompactionPolicy (Task 015, D82/D25).
//!
//! Pure arithmetic over injected measurement — no provider calls.
//! Formula is D82 (supersedes D64): proportional caps + floor above
//! fixed cost. `request_max_tokens` is this request's `max_tokens`,
//! defaulted to model ceiling only when absent.

use serde::{Deserialize, Serialize};

pub mod compact;

/// Input to trigger computation. All counts tokens. camelCase on the wire,
/// the same boundary rule as `Measurement` (review 22).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterInput {
    pub context_window: u64,
    pub model_max_output: u64,
    pub request_max_tokens: Option<u64>,
    pub headroom_in: u64,
    pub system_tokens: u64,
    pub tool_schema_tokens: u64,
}

/// CONTRACTS §4 measurement, on the contracted wire: camelCase keys
/// (`inputTokens`, `triggerTokens`, …), matching the TS shape — clauro-core
/// renames the same way (review 22). Never snake_case across the boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
///
/// Internally tagged and kebab-cased so the Rust enum carries the exact
/// CONTRACTS §4 wire: `{kind:'committed'|'pruned'|'no-progress'}` — not the
/// externally-tagged PascalCase serde would default to (review 22).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
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

/// D82's arithmetic, computed once. `compute_trigger` and `measure` both
/// read this, so the trigger can never diverge from the measurement (the
/// copy-paste drift review 22 found). Never panics; absurd inputs clamp via
/// the proportional caps and saturating subtraction.
struct Surface {
    window: u64,
    headroom_tokens: u64,
    reserved: u64,
    ratio_bound: u64,
    usable_tokens: u64,
    trigger_tokens: u64,
}

fn surface(input: &MeterInput) -> Surface {
    let window = input.context_window.max(1);
    let headroom_cap = ((window as f64) * 0.25) as u64;
    let headroom_tokens = input.headroom_in.min(65_536).min(headroom_cap);
    // Absurd request_max saturates here, then caps at 50% window.
    let req = input.request_max_tokens.unwrap_or(input.model_max_output);
    let reserve_cap = ((window as f64) * 0.50) as u64;
    let reserved = req.max(20_000).min(reserve_cap);
    let fixed_cost = input
        .system_tokens
        .saturating_add(input.tool_schema_tokens)
        .saturating_add(512);
    let ratio_bound = ((window as f64) * 0.8) as u64;
    let usable_tokens = window
        .saturating_sub(reserved)
        .saturating_sub(headroom_tokens);
    // The floor can exceed a small window outright (fixed cost above the
    // whole context window): a trigger input can never reach means Pressure
    // never fires and compaction waits for a provider rejection. Clamp to
    // the window so the trigger stays reachable (guard: Tasks/015:34,
    // review 22).
    let trigger_tokens = fixed_cost
        .saturating_add(2_048)
        .max(ratio_bound.min(usable_tokens))
        .min(window);
    Surface {
        window,
        headroom_tokens,
        reserved,
        ratio_bound,
        usable_tokens,
        trigger_tokens,
    }
}

/// D82 trigger for a surface. Always `0 < trigger <= context_window`.
#[must_use]
pub fn compute_trigger(input: &MeterInput) -> u64 {
    surface(input).trigger_tokens
}

/// Full measurement for a surface of `input_tokens` size.
#[must_use]
pub fn measure(input: &MeterInput, input_tokens: u64) -> Measurement {
    let s = surface(input);
    Measurement {
        input_tokens,
        reserved: s.reserved,
        headroom_tokens: s.headroom_tokens,
        usable_tokens: s.usable_tokens,
        ratio_bound: s.ratio_bound,
        trigger_tokens: s.trigger_tokens,
        context_window: s.window,
    }
}

#[cfg(test)]
mod wire {
    use super::{CompactionResult, Measurement};

    /// CONTRACTS §4 pin (review 22): the compaction outcome serialises as
    /// the internally-tagged kebab-case wire `{kind:'committed'|'pruned'|
    /// 'no-progress'}` — the serde-attr revert this catches used to surface
    /// only at the Tauri/TS boundary, as externally-tagged PascalCase.
    #[test]
    fn compaction_result_carries_the_contracted_kind_wire() {
        let value = serde_json::to_value(CompactionResult::NoProgress).expect("serialises");
        assert_eq!(
            value,
            serde_json::json!({"kind": "no-progress"}),
            "the wire is {{kind:'no-progress'}}, never {{NoProgress:{{}}}}"
        );
        let committed = serde_json::to_value(CompactionResult::Committed { generation: 3 })
            .expect("serialises");
        assert_eq!(
            committed,
            serde_json::json!({"kind": "committed", "generation": 3})
        );
        // Round-trip: the wire form deserialises back to the same value.
        let back: CompactionResult =
            serde_json::from_value(value).expect("the contracted wire parses");
        assert_eq!(back, CompactionResult::NoProgress);
    }

    /// CONTRACTS §4 pin (review 22): `Measurement` crosses camelCase, never
    /// snake_case — clauro-core renames the same way, and the TS shape reads
    /// `inputTokens`, not `input_tokens`.
    #[test]
    fn measurement_round_trips_on_the_camel_case_wire() {
        let m = Measurement {
            input_tokens: 1_000,
            reserved: 20_000,
            headroom_tokens: 4_096,
            usable_tokens: 163_840,
            ratio_bound: 163_840,
            trigger_tokens: 80_000,
            context_window: 204_800,
        };
        let value = serde_json::to_value(m.clone()).expect("serialises");
        let obj = value.as_object().expect("object");
        assert!(obj.contains_key("inputTokens"), "{obj:?}");
        assert!(obj.contains_key("triggerTokens"), "{obj:?}");
        assert!(
            !obj.contains_key("input_tokens"),
            "snake_case leaked: {obj:?}"
        );
        let back: Measurement = serde_json::from_value(value).expect("round-trips");
        assert_eq!(back, m);
    }
}
