//! Task 016 failing tests first — client-side compaction, non-Anthropic only.

use clauro_core::ContentBlock;
use clauro_tokens::compact::{
    balanced_boundary, build_summary_request, is_anthropic_blocked, usage_from_iterations,
    UsageIter,
};
use clauro_tokens::{CompactionResult, CompactionTrigger};

fn text(s: &str) -> ContentBlock {
    ContentBlock::Text {
        text: s.to_string(),
    }
}
fn tool_use(id: &str) -> ContentBlock {
    ContentBlock::ToolUse {
        id: id.to_string(),
        name: "fs".to_string(),
        input_json: "{}".to_string(),
    }
}
fn tool_result(id: &str) -> ContentBlock {
    ContentBlock::ToolResult {
        tool_use_id: id.to_string(),
        status: clauro_core::ToolStatus::Ok,
        preview: "ok".to_string(),
        preview_path: None,
    }
}

#[test]
fn never_on_anthropic() {
    assert!(is_anthropic_blocked("anthropic"));
    assert!(!is_anthropic_blocked("openai-compatible"));
    assert!(!is_anthropic_blocked("deepseek"));
}

#[test]
fn no_unbalanced_boundary() {
    // tool_use at 1 without result until 3; boundary at 1 or 2 splits pair.
    let blocks = vec![
        text("a"),
        tool_use("u1"),
        text("b"),
        tool_result("u1"),
        text("c"),
    ];
    let b = balanced_boundary(&blocks, 2).expect("boundary");
    // Must land where pair intact: either <=1 or >=4 in block index terms.
    let prefix = &blocks[..b];
    let mut open: Vec<String> = vec![];
    for blk in prefix {
        match blk {
            ContentBlock::ToolUse { id, .. } => open.push(id.clone()),
            ContentBlock::ToolResult { tool_use_id, .. } => {
                open.retain(|x| *x != *tool_use_id);
            }
            _ => {}
        }
    }
    assert!(open.is_empty(), "boundary splits tool pair");
}

#[test]
fn pressure_vs_overflow_intent() {
    // Policy takes intent only (D25): overflow bypasses threshold check.
    let t: CompactionTrigger = CompactionTrigger::ContextOverflow;
    assert_ne!(t, CompactionTrigger::Pressure);
}

#[test]
fn no_progress_cannot_retry() {
    assert!(!CompactionResult::NoProgress.authorises_retry());
}

#[test]
fn prefix_extension_shape() {
    let sys = "system prompt".to_string();
    let tools = vec!["fs".to_string(), "memory".to_string()];
    let prefix = vec![text("hello"), text("world")];
    let req = build_summary_request(sys.clone(), tools.clone(), &prefix, "summarise now");
    assert_eq!(req.system, sys);
    assert_eq!(req.tools, tools);
    assert_eq!(req.messages().len(), prefix.len() + 1);
    assert_eq!(req.messages()[..prefix.len()], prefix);
    assert!(req.trailing_is_user_only());
}

/// Review 22 — the D13 invariant must be representable: the directive is its
/// own field, not inferred from "last block happens to be non-empty Text" on
/// a role-less enum. `messages()` assembles the wire shape; the trailing
/// message is the directive *by construction*.
#[test]
fn directive_is_a_first_class_field() {
    let prefix = vec![text("earlier")];
    let req = build_summary_request(
        "sys".to_string(),
        vec!["fs".to_string()],
        &prefix,
        "summarise this",
    );
    assert_eq!(req.prefix, prefix, "the replayed prefix is its own field");
    assert_eq!(req.directive, "summarise this");
    let msgs = req.messages();
    assert_eq!(msgs.len(), prefix.len() + 1);
    assert_eq!(msgs[..prefix.len()], prefix[..]);
    assert_eq!(msgs[prefix.len()], text("summarise this"));
    assert!(req.trailing_is_user_only());

    // The failure the type can now express: a blank directive would leave an
    // empty trailing message — nothing for the summariser to obey.
    let blank = build_summary_request("sys".to_string(), vec![], &[], "");
    assert!(!blank.trailing_is_user_only());
}

#[test]
fn usage_iterations_post_compaction() {
    // Top-level zero after compaction; iterations carry truth (D70).
    let iters = vec![
        UsageIter {
            input: 100,
            output: 50,
        },
        UsageIter {
            input: 0,
            output: 0,
        },
    ];
    let (billing, context) = usage_from_iterations(&iters);
    assert_eq!(billing, 150);
    assert_eq!(context, 0);
    // Threshold path non-zero top-level must not be read as context blindly —
    // caller uses last iteration, not top-level.
    let iters2 = vec![
        UsageIter {
            input: 100,
            output: 50,
        },
        UsageIter {
            input: 9000,
            output: 200,
        },
    ];
    let (_, ctx2) = usage_from_iterations(&iters2);
    assert_eq!(ctx2, 9200);
}

/// Review 22 — a boundary summarising NOTHING still advances the generation
/// (legal under D63; D17's anti-thrash cannot see it): a dangling `tool_use`
/// at index 0 must fail closed, not compact the whole history into an
/// instruction-only summary.
#[test]
fn boundary_never_summarises_nothing() {
    let blocks = vec![tool_use("c1"), text("hi")];
    assert_eq!(
        balanced_boundary(&blocks, 2),
        None,
        "Some(0) would advance the generation while summarising nothing"
    );
    // Healthy history, target 0: still nothing to summarise.
    let healthy = vec![text("hi")];
    assert_eq!(balanced_boundary(&healthy, 0), None);
}

/// Review 22 — D61 guards tool pairs; the thinking run needs the same guard.
/// A boundary between two Thinking blocks leaves the retained suffix starting
/// mid-run, and clauro-loop withholds the later reasoning as a consequence.
#[test]
fn boundary_never_splits_a_thinking_run() {
    let blocks = vec![
        text("a"),
        ContentBlock::Thinking {
            text: "t1".to_string(),
            signature: "sig1".to_string(),
            display: clauro_core::ThinkingDisplay::Full,
        },
        ContentBlock::Thinking {
            text: "t2".to_string(),
            signature: "sig2".to_string(),
            display: clauro_core::ThinkingDisplay::Full,
        },
        text("b"),
    ];
    assert_eq!(
        balanced_boundary(&blocks, 2),
        Some(1),
        "target 2 would cut between the two thinking blocks"
    );
}

/// Review 22 — the crate's posture is "never panics": absurd usage
/// saturates at u64::MAX instead of overflowing in debug and wrapping in
/// release (billing corruption).
#[test]
fn usage_sums_saturate_instead_of_panicking() {
    let iters = vec![
        UsageIter {
            input: u64::MAX,
            output: u64::MAX,
        },
        UsageIter {
            input: 1,
            output: 1,
        },
    ];
    let (billing, context) = usage_from_iterations(&iters);
    assert_eq!(billing, u64::MAX, "saturates, never wraps");
    assert_eq!(context, 2, "context takes the last iteration");
}
