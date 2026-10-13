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

/// Summarisation request (D13): byte-identical prefix + one trailing user
/// directive. `tools` carried through though summariser never calls one.
///
/// The D13 invariant is representable here: `prefix` is what replays
/// verbatim, `directive` is the one trailing message *by construction* —
/// nothing is inferred from a role-less block list (review 22).
#[derive(Debug, Clone, PartialEq)]
pub struct SummaryRequest {
    pub system: String,
    pub tools: Vec<String>,
    pub prefix: Vec<ContentBlock>,
    pub directive: String,
}

impl SummaryRequest {
    /// The wire shape: prefix blocks verbatim, directive as the one trailing
    /// message (D13).
    #[must_use]
    pub fn messages(&self) -> Vec<ContentBlock> {
        let mut out = self.prefix.clone();
        out.push(ContentBlock::Text {
            text: self.directive.clone(),
        });
        out
    }

    /// The trailing message is the directive, and it must carry content —
    /// a blank directive would give the summariser nothing to obey. Role is
    /// the consumer's to apply (clauro-tokens never serializes).
    #[must_use]
    pub fn trailing_is_user_only(&self) -> bool {
        !self.directive.is_empty()
    }
}

/// Never invoke client compaction for Anthropic (D15/D58).
#[must_use]
pub fn is_anthropic_blocked(provider: &str) -> bool {
    provider.eq_ignore_ascii_case("anthropic")
}

/// Land only on a balanced boundary: no `tool_use` without its result
/// (D61/D18) and no boundary inside a thinking run — a suffix starting
/// mid-run gets its later reasoning withheld downstream. Walks backward from
/// `target`.
///
/// Returns `None` when no non-empty prefix balances. `Some(0)` would be a
/// boundary summarising NOTHING while the generation still advances — legal
/// under D63, invisible to D17's anti-thrash — so a dangling `tool_use` at
/// index 0 fails closed instead of compacting the whole history into an
/// instruction-only summary (review 22).
#[must_use]
pub fn balanced_boundary(blocks: &[ContentBlock], target: usize) -> Option<usize> {
    let mut t = target.min(blocks.len());
    while t > 0 {
        if prefix_balanced(&blocks[..t]) && boundary_whole(blocks, t) {
            return Some(t);
        }
        t -= 1;
    }
    None
}

/// Whether a cut at `t` keeps every block whole. D61's pair rule is the
/// caller's `prefix_balanced`; this guards the run no rule named yet: two
/// adjacent `Thinking` blocks on either side of the cut are one run split in
/// half (review 22).
fn boundary_whole(blocks: &[ContentBlock], t: usize) -> bool {
    if t == 0 || t >= blocks.len() {
        return true;
    }
    let run_across = matches!(blocks[t - 1], ContentBlock::Thinking { .. })
        && matches!(blocks[t], ContentBlock::Thinking { .. });
    !run_across
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

/// Prefix-extension trick (D13): system+tools replayed verbatim, one
/// directive trailing.
#[must_use]
pub fn build_summary_request(
    system: String,
    tools: Vec<String>,
    prefix: &[ContentBlock],
    instruction: &str,
) -> SummaryRequest {
    SummaryRequest {
        system,
        tools,
        prefix: prefix.to_vec(),
        directive: instruction.to_string(),
    }
}

/// Usage after compaction from iterations (D70): sum billing, last context.
/// Saturating throughout — absurd u64 usage must not panic in debug or wrap
/// in release (billing corruption); the crate's posture is never-panic.
#[must_use]
pub fn usage_from_iterations(iters: &[UsageIter]) -> (u64, u64) {
    let billing = iters.iter().fold(0u64, |acc, i| {
        acc.saturating_add(i.input.saturating_add(i.output))
    });
    let context = iters.last().map_or(0, |i| i.input.saturating_add(i.output));
    (billing, context)
}
