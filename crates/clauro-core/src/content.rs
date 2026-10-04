//! Content blocks — the union every view renders (`CONTRACTS.md` §2).
//!
//! One shape for both providers (D54): Anthropic thinking blocks and OpenAI
//! reasoning tokens normalise to the same `Thinking`. `ToolUse.input_json`
//! crosses as canonical JSON text — this crate stays serde-only by mechanical
//! test, and parsing lives in the store layer where validation errors are
//! typed.

use crate::ToolStatus;
use serde::{Deserialize, Serialize};
use std::fmt;

/// How much of the thinking the collapsed renderer shows (D54: one
/// collapsible inline region, never a side pane).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingDisplay {
    Full,
    Summary,
}

/// Notice severity: dropped thinking, provider errors (D71, D80).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
}

/// One selectable answer on a question card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
}

/// The union. `kind`-tagged so the wire form matches `CONTRACTS.md` §2
/// (`text`, `thinking`, `tool_use`, `tool_result`, `artifact_ref`,
/// `question_card`, `summary`, `compaction`, `notice`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
        /// REQUIRED in practice: a persister that stops at `content_block_stop`
        /// replays blocks that fail verification (D72). Empty signatures are
        /// rejected on construction *and* deserialization — persisted and wire
        /// payloads take the deserialize path.
        #[serde(deserialize_with = "non_empty_signature")]
        signature: String,
        display: ThinkingDisplay,
    },
    ToolUse {
        id: String,
        name: String,
        input_json: String,
    },
    ToolResult {
        tool_use_id: String,
        status: ToolStatus,
        preview: String,
        preview_path: Option<String>,
    },
    ArtifactRef {
        artifact_id: String,
        version: i64,
        title: String,
    },
    QuestionCard {
        id: String,
        prompt: String,
        options: Vec<QuestionOption>,
        allow_free_text: bool,
        resolved: Option<String>,
    },
    Summary {
        text: String,
        boundary: i64,
        generation: i64,
    },
    /// Anthropic only (D69). Parsed in 005, acted on in 017.
    Compaction {
        provider_block_id: String,
    },
    Notice {
        level: NoticeLevel,
        text: String,
    },
}

/// Rejection for a thinking block without its signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MissingSignature;

impl fmt::Display for MissingSignature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("thinking block requires a signature (D72)")
    }
}

impl std::error::Error for MissingSignature {}

impl ContentBlock {
    /// Build a `Thinking` with its signature checked. Empty signatures fail
    /// here, not mid-thread on replay (D72). Deserialization enforces the
    /// same rule; direct struct construction is same-crate code and covered
    /// by the deserialize test's contract, not by this function.
    pub fn thinking(
        text: &str,
        signature: &str,
        display: ThinkingDisplay,
    ) -> Result<Self, MissingSignature> {
        if signature.is_empty() {
            return Err(MissingSignature);
        }
        Ok(Self::Thinking {
            text: text.to_string(),
            signature: signature.to_string(),
            display,
        })
    }
}

/// Length of the leading present run. Thinking re-sends only as an unbroken
/// run: removing one block from the *middle* invalidates every later block
/// (D72), so only `present[..unbroken_run_end]` is re-sendable.
#[must_use]
pub fn unbroken_run_end(present: &[bool]) -> usize {
    present.iter().take_while(|&&p| p).count()
}

fn non_empty_signature<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let s = String::deserialize(d)?;
    if s.is_empty() {
        return Err(serde::de::Error::custom(MissingSignature));
    }
    Ok(s)
}
