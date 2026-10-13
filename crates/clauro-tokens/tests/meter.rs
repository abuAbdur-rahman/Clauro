//! Task 015 failing tests first (D82, D25).
//! Test recomputes D82 formula in-test; table + function must agree.

use clauro_tokens::{compute_trigger, measure, CompactionResult, MeterInput};

/// Mirror of D82, kept SECONDARY to the hand-written literals below: it
/// proves the function matches the formula, the literals prove the formula
/// matches D82. Both must hold — a constant misread identically in both
/// places passes the mirror alone (review 22).
fn expected(input: &MeterInput) -> u64 {
    let window = input.context_window.max(1);
    let headroom = [input.headroom_in, 65_536, ((window as f64) * 0.25) as u64]
        .into_iter()
        .min()
        .unwrap_or(0);
    let req = input.request_max_tokens.unwrap_or(input.model_max_output);
    let reserved = (req.max(20_000)).min(((window as f64) * 0.50) as u64);
    let fixed_cost = input.system_tokens + input.tool_schema_tokens + 512;
    let ratio = ((window as f64) * 0.8) as u64;
    let usable = window.saturating_sub(reserved).saturating_sub(headroom);
    (fixed_cost + 2_048).max(ratio.min(usable)).min(window) // the review-22 clamp: never above the window
}

/// One golden row: (window, model_max, request_max, headroom_in, sys, tools,
///  reserved, headroom, ratio_bound, usable_bound, trigger).
type GoldenRow = (
    u64,
    u64,
    Option<u64>,
    u64,
    u64,
    u64,
    u64,
    u64,
    u64,
    u64,
    u64,
);

#[test]
fn d82_golden_table_matches_function() {
    // Triggers for the first four rows are the hand-published D82 numbers
    // (Tasks/015:27-30 and DECISIONS.md D82 itself: "130,000", "800,000").
    // Tasks/015's last two rows predate D82's own correction — its formula
    // line has no fixed-cost floor, which D82:513-537 then added — so those
    // two triggers are D82-derived here: floor = sys+tools+512+2048 = 8,560,
    // clamped to the 8,192 window (review 22).
    let rows: [GoldenRow; 6] = [
        (
            200_000,
            128_000,
            Some(128_000),
            65_536,
            6_000,
            0, //
            100_000,
            50_000,
            160_000,
            50_000,
            50_000,
        ),
        (
            200_000,
            128_000,
            Some(8_000),
            65_536,
            6_000,
            0, //
            20_000,
            50_000,
            160_000,
            130_000,
            130_000,
        ),
        (
            1_000_000, 128_000, None, 65_536, 6_000, 0, //
            128_000, 65_536, 800_000, 806_464, 800_000,
        ),
        (
            32_000, 4_096, None, 0, 6_000, 0, //
            16_000, 0, 25_600, 16_000, 16_000,
        ),
        (
            8_192, 2_048, None, 0, 6_000, 0, //
            4_096, 0, 6_553, 4_096, 8_192,
        ),
        (
            16_000, 4_096, None, 65_536, 6_000, 0, //
            8_000, 4_000, 12_800, 4_000, 8_560,
        ),
    ];
    for (
        window,
        model_max,
        req,
        headroom_in,
        sys,
        tools,
        reserved,
        headroom,
        ratio,
        usable,
        trigger,
    ) in rows
    {
        let input = MeterInput {
            context_window: window,
            model_max_output: model_max,
            request_max_tokens: req,
            headroom_in,
            system_tokens: sys,
            tool_schema_tokens: tools,
        };
        let m = measure(&input, 42);
        assert_eq!(m.reserved, reserved, "reserved, window={window}");
        assert_eq!(m.headroom_tokens, headroom, "headroom, window={window}");
        assert_eq!(m.ratio_bound, ratio, "ratioBound, window={window}");
        assert_eq!(m.usable_tokens, usable, "usableBound, window={window}");
        assert_eq!(m.trigger_tokens, trigger, "trigger, window={window}");
        assert_eq!(m.context_window, window, "window passthrough");
        assert_eq!(m.input_tokens, 42, "input passthrough");
        // The measurement's trigger and the standalone trigger are one
        // number — they can no longer diverge.
        assert_eq!(compute_trigger(&input), m.trigger_tokens);
        // Secondary: the mirror formula agrees too.
        assert_eq!(
            expected(&input),
            m.trigger_tokens,
            "mirror, window={window}"
        );
    }
}

/// Tasks/015:34 guard — the exact failure class review 22 found: a trigger
/// above the window is unreachable, so Pressure never fires and compaction
/// waits for a provider rejection.
#[test]
fn trigger_is_positive_and_reachable_on_every_row() {
    let rows = [
        (200_000u64, 128_000u64, Some(128_000u64), 65_536u64),
        (200_000, 128_000, Some(8_000), 65_536),
        (1_000_000, 128_000, None, 65_536),
        (32_000, 4_096, None, 0),
        (8_192, 2_048, None, 0),
        (16_000, 4_096, None, 65_536),
        (4_096, 2_048, None, 0),
        (2_048, 1_024, None, 0),
    ];
    for (window, model_max, req, headroom_in) in rows {
        let input = MeterInput {
            context_window: window,
            model_max_output: model_max,
            request_max_tokens: req,
            headroom_in,
            system_tokens: 6_000,
            tool_schema_tokens: 0,
        };
        let t = compute_trigger(&input);
        assert!(t > 0, "trigger must be positive, window={window}");
        assert!(
            t <= window,
            "trigger must be reachable — input can never exceed the window: \
             trigger={t} window={window}"
        );
        // The other two guard clauses from Tasks/015:34.
        let m = measure(&input, 0);
        assert!(
            m.reserved * 2 <= window,
            "reserved must stay at or below 50% of the window: {}",
            m.reserved
        );
        assert!(
            m.headroom_tokens * 4 <= window,
            "headroom must stay at or below 25% of the window: {}",
            m.headroom_tokens
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
