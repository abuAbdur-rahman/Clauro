//! Task 016 failing tests first — client-side compaction, non-Anthropic only.

use clauro_core::ContentBlock;
use clauro_tokens::compact::{
    balanced_boundary, build_summary_request, is_anthropic_blocked, summariser_tool_schema,
    usage_from_iterations, UsageIter,
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
    assert_eq!(req.messages.len(), prefix.len() + 1);
    assert_eq!(req.messages[..prefix.len()], prefix);
    assert!(req.trailing_is_user_only());
    // Summariser carries tools but has no tool schema to call.
    assert!(summariser_tool_schema(&req).is_none());
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
