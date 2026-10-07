//! Store rows → `ContentBlock`, the shape every view renders (006).
//!
//! The store persists `(kind, payload JSON, signature)`. `CONTRACTS.md` §2
//! defines what a view renders: a discriminated union, one shape for both
//! providers (D54). This module is the only translation between them.
//!
//! **Nothing here throws and nothing is dropped** (`D55`). A payload this build
//! cannot parse, or a `kind` it does not recognise, becomes a `Notice` in the
//! transcript rather than a panic or a silent omission — silently dropping a
//! row renders a plausible-looking wrong transcript, which is the failure mode
//! the whole degrade-visibly rule exists to prevent.
//!
//! `generation` and `role` ride along on the wrapper so I3 is checkable from
//! the view side, and so a renderer can style a user turn differently from an
//! assistant one without a second query.

use clauro_core::{ContentBlock, NoticeLevel, ThinkingDisplay, ToolStatus};
use clauro_store::transcript::FullBlock;
use serde_json::Value;

/// One rendered row: the block, plus the store context a view needs and the
/// contract's block payload does not carry.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RenderRow {
    pub block: ContentBlock,
    /// `assistant` or `user`, from the owning message.
    pub role: String,
    /// Store row id — the anchor a view uses to key an append-only list.
    pub id: String,
    /// Block sequence within its message.
    pub seq: i64,
    /// Compaction generation (D63). I3 asserts it is non-decreasing along
    /// `(thread, seq)`.
    pub generation: i64,
}

/// Translate every block of a thread, in store order.
///
/// Order is the caller's: pass `blocks_for_thread` output and it comes back in
/// surface order. An empty thread yields an empty vec, not an error.
#[must_use]
pub fn blocks_to_contract(blocks: &[FullBlock]) -> Vec<RenderRow> {
    blocks.iter().map(row_to_contract).collect()
}

/// Translate one block. Total: every input produces exactly one output row.
#[must_use]
pub fn row_to_contract(block: &FullBlock) -> RenderRow {
    let parsed: Option<Value> = serde_json::from_str(&block.payload).ok();
    // The notice names the row **id**, not the raw payload: an id lets a user
    // find the row, while dumping unparsed bytes into the transcript is noise
    // that can itself carry content the app never meant to render.
    let unreadable = || {
        notice(
            NoticeLevel::Warn,
            &format!(
                "could not read this {} row ({}); the row is preserved",
                block.kind, block.id
            ),
        )
    };
    let content = parsed
        .and_then(|value| from_value(block, value))
        .unwrap_or_else(unreadable);
    RenderRow {
        block: content,
        role: block.role.clone(),
        id: block.id.clone(),
        seq: block.seq,
        generation: block.generation,
    }
}

fn notice(level: NoticeLevel, text: &str) -> ContentBlock {
    ContentBlock::Notice {
        level,
        text: text.to_string(),
    }
}

/// Map one parsed payload. `None` means "this payload does not satisfy its
/// variant" and becomes a notice — a required field is never defaulted,
/// because a fabricated id would manufacture the pairing I1 verifies.
fn from_value(block: &FullBlock, value: Value) -> Option<ContentBlock> {
    match block.kind.as_str() {
        "text" => Some(ContentBlock::Text {
            text: value.get("text")?.as_str()?.to_string(),
        }),
        "thinking" => {
            let text = value.get("text")?.as_str()?.to_string();
            // D72: the signature is required, and an empty one is rejected on
            // construction. A thinking row stored without it cannot be
            // re-sent, so it must not reach a view as a valid block.
            let signature = block.signature.clone().filter(|s| !s.is_empty())?;
            let display = match value.get("display").and_then(Value::as_str) {
                Some("summary") => ThinkingDisplay::Summary,
                _ => ThinkingDisplay::Full,
            };
            Some(ContentBlock::Thinking {
                text,
                signature,
                display,
            })
        }
        "tool_use" => Some(ContentBlock::ToolUse {
            id: value.get("id")?.as_str()?.to_string(),
            name: value.get("name")?.as_str()?.to_string(),
            input_json: value
                .get("input")
                .map_or_else(String::new, Value::to_string),
        }),
        "tool_result" => Some(ContentBlock::ToolResult {
            tool_use_id: value.get("tool_use_id")?.as_str()?.to_string(),
            status: parse_status(value.get("status")?)?,
            preview: value
                .get("preview")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            preview_path: value
                .get("preview_path")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        "notice" => Some(ContentBlock::Notice {
            level: match value.get("level").and_then(Value::as_str) {
                Some("error") => NoticeLevel::Error,
                Some("info") => NoticeLevel::Info,
                _ => NoticeLevel::Warn,
            },
            text: value.get("text")?.as_str()?.to_string(),
        }),
        "compaction" => Some(ContentBlock::Compaction {
            provider_block_id: value.get("provider_block_id")?.as_str()?.to_string(),
        }),
        other => Some(ContentBlock::Notice {
            level: NoticeLevel::Warn,
            text: format!("this app does not render a {other} block yet; the row is preserved"),
        }),
    }
}

/// An unrecognised status is a notice, never a default. Collapsing an unknown
/// status into `ok` would render a failure as a success.
fn parse_status(value: &Value) -> Option<ToolStatus> {
    match value.as_str()? {
        "ok" => Some(ToolStatus::Ok),
        "error" => Some(ToolStatus::Error),
        "aborted" => Some(ToolStatus::Aborted),
        "rejected" => Some(ToolStatus::Rejected),
        _ => None,
    }
}
