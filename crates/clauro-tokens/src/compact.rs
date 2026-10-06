//! Client-side compaction, non-Anthropic only (Task 016, D13/D16/D18/D57/D61/D63).
//!
//! Pure functions over injected blocks — no provider calls, no I/O.
//! Structure decides legality (D61); arithmetic decides where (D82).

use clauro_core::ContentBlock;
use serde::{Deserialize, Serialize};

/// One usage iteration (D70/D57). Billing sums all; context takes last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageIter {
    pub input: u64,
    pub output: u64,
}

/// Summarisation request: byte-identical prefix + one trailing user msg (D13).
/// `tools` carried through though summariser never calls one.
#[derive(Debug, Clone, PartialEq)]
pub struct SummaryRequest {
    pub system: String,
    pub tools: Vec<String>,
    pub messages: Vec<ContentBlock>,
}

impl SummaryRequest {
    /// Trailing message is user-only directive; system/tools untouched.
    #[must_use]
    pub fn trailing_is_user_only(&self) -> bool {
        match self.messages.last() {
            Some(ContentBlock::Text { text }) => !text.is_empty(),
            _ => false,
        }
    }
}

/// Never invoke client compaction for Anthropic (D15/D58).
#[must_use]
pub fn is_anthropic_blocked(provider: &str) -> bool {
    provider.eq_ignore_ascii_case("anthropic")
}

/// Land only on balanced boundary: no `tool_use` without its result (D61/D18).
/// Walks backward from `target` until prefix has no open calls.
#[must_use]
pub fn balanced_boundary(blocks: &[ContentBlock], target: usize) -> Option<usize> {
    let mut t = target.min(blocks.len());
    loop {
        if prefix_balanced(&blocks[..t]) {
            return Some(t);
        }
        if t == 0 {
            return Some(0);
        }
        t -= 1;
    }
}

fn prefix_balanced(prefix: &[ContentBlock]) -> bool {
    let mut open: Vec<&str> = vec![];
    for b in prefix {
        match b {
            ContentBlock::ToolUse { id, .. } => open.push(id.as_str()),
            ContentBlock::ToolResult { tool_use_id, .. } => {
                if let Some(pos) = open.iter().position(|x| *x == tool_use_id) {
                    open.remove(pos);
                }
            }
            _ => {}
        }
    }
    open.is_empty()
}

/// Prefix-extension trick (D13): system+tools replayed verbatim.
#[must_use]
pub fn build_summary_request(
    system: String,
    tools: Vec<String>,
    prefix: &[ContentBlock],
    instruction: &str,
) -> SummaryRequest {
    let mut messages = prefix.to_vec();
    messages.push(ContentBlock::Text {
        text: instruction.to_string(),
    });
    SummaryRequest {
        system,
        tools,
        messages,
    }
}

/// Summariser cannot call a tool: no schema present (instruction + absence).
#[must_use]
pub fn summariser_tool_schema(_req: &SummaryRequest) -> Option<&str> {
    None
}

/// Usage after compaction from iterations (D70): sum billing, last context.
#[must_use]
pub fn usage_from_iterations(iters: &[UsageIter]) -> (u64, u64) {
    let billing = iters.iter().map(|i| i.input + i.output).sum();
    let context = iters.last().map(|i| i.input + i.output).unwrap_or(0);
    (billing, context)
}
