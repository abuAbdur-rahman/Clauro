//! Task 015 failing tests first (D82, D25).
//! Test recomputes D82 formula in-test; table + function must agree.

use clauro_tokens::{compute_trigger, CompactionResult, MeterInput};

fn expected(input: &MeterInput) -> u64 {
    let window = input.context_window;
    let headroom = [input.headroom_in, 65_536, ((window as f64) * 0.25) as u64]
        .into_iter()
        .min()
        .unwrap_or(0);
    let req = input.request_max_tokens.unwrap_or(input.model_max_output);
    let reserved = (req.max(20_000)).min(((window as f64) * 0.50) as u64);
    let fixed_cost = input.system_tokens + input.tool_schema_tokens + 512;
    let ratio = ((window as f64) * 0.8) as u64;
    let usable = window.saturating_sub(reserved).saturating_sub(headroom);
    (fixed_cost + 2_048).max(ratio.min(usable))
}

#[test]
fn d82_table_matches_function() {
    let rows = [
        // (window, model_max, request_max, headroom_in, sys, tools)
        (
            200_000u64,
            128_000u64,
            Some(128_000u64),
            65_536u64,
            6_000u64,
            0u64,
        ),
        (200_000, 128_000, Some(8_000), 65_536, 6_000, 0),
        (1_000_000, 128_000, None, 65_536, 6_000, 0),
        (32_000, 4_096, None, 0, 6_000, 0),
        (8_192, 2_048, None, 0, 6_000, 0),
        (16_000, 4_096, None, 65_536, 6_000, 0),
    ];
    for (window, model_max, req, headroom_in, sys, tools) in rows {
        let input = MeterInput {
            context_window: window,
            model_max_output: model_max,
            request_max_tokens: req,
            headroom_in,
            system_tokens: sys,
            tool_schema_tokens: tools,
        };
        assert_eq!(
            compute_trigger(&input),
            expected(&input),
            "D82 mismatch window={window} req={req:?}"
        );
    }
}

#[test]
fn request_max_binds_not_model_ceiling() {
    // D82 defect 1: reserving model ceiling (128k) when request asks 8k
    // over-reserves by 80k on a 200k window.
    let wide = MeterInput {
        context_window: 200_000,
        model_max_output: 128_000,
        request_max_tokens: Some(8_000),
        headroom_in: 65_536,
        system_tokens: 6_000,
        tool_schema_tokens: 0,
    };
    let narrow = MeterInput {
        context_window: 200_000,
        model_max_output: 128_000,
        request_max_tokens: Some(128_000),
        headroom_in: 65_536,
        system_tokens: 6_000,
        tool_schema_tokens: 0,
    };
    assert!(compute_trigger(&wide) - compute_trigger(&narrow) >= 70_000);
}

#[test]
fn trigger_above_fixed_cost() {
    // D82 defect 2: trigger must exceed cost of sending request,
    // else compaction fires every turn on small models.
    let input = MeterInput {
        context_window: 8_192,
        model_max_output: 2_048,
        request_max_tokens: None,
        headroom_in: 0,
        system_tokens: 6_000,
        tool_schema_tokens: 0,
    };
    let fixed = input.system_tokens + input.tool_schema_tokens + 512;
    assert!(compute_trigger(&input) > fixed);
}

#[test]
fn absurd_max_output_clamps() {
    let base = MeterInput {
        context_window: 200_000,
        model_max_output: 128_000,
        request_max_tokens: Some(8_000),
        headroom_in: 1_000,
        system_tokens: 1_000,
        tool_schema_tokens: 1_000,
    };
    let absurd = MeterInput {
        request_max_tokens: Some(u64::MAX),
        ..base.clone()
    };
    // Must not panic; clamps to 50% window reserve.
    let t = compute_trigger(&absurd);
    assert!(t > 0 && t <= base.context_window);
}

#[test]
fn no_progress_variant_exists() {
    // D17/D63: summariser changed nothing is representable,
    // and cannot authorise retry.
    let r = CompactionResult::NoProgress;
    assert!(!r.authorises_retry());
    assert!(!CompactionResult::Pruned { generation: 1 }.authorises_retry());
    assert!(CompactionResult::Committed { generation: 1 }.authorises_retry());
}
