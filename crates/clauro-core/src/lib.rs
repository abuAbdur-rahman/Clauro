//! `clauro-core`: domain types. No I/O, no dependencies beyond `serde`.
//!
//! The type layer (`TECH_STACK.md` §2). Anything doing I/O, touching the
//! network, or knowing Tauri exists lives in another crate. The dependency
//! rule is mechanical, not conventional: see `tests/no_extra_deps.rs`.

use serde::{Deserialize, Serialize};

pub mod content;
pub mod tools;

pub use content::{
    unbroken_run_end, ContentBlock, MissingSignature, NoticeLevel, QuestionOption, ThinkingDisplay,
};
pub use tools::{Effect, PermissionRule, ToolContext, ToolOutcome, DEFAULT_EFFECT};

/// A placeholder proving the crate compiles and tests run headless.
/// Real domain types (`ContentBlock`, `ToolOutcome`, `Measurement`) land with
/// the tasks that own them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placeholder {
    pub name: String,
}

/// The four tool-result statuses shared by storage and the tool loop.
///
/// `CONTRACTS.md` §1 (`tool_result.status`) and §3 (`ToolOutcome`) agree on
/// exactly four outcomes: a missing file is `error`, a cancelled call is
/// `aborted`, a declined command is `rejected`, and a non-zero exit is `ok`.
/// Nothing throws across the tool boundary (D55). Task 004 owns the stored
/// half; the loop owns the returned half.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolStatus {
    Ok,
    Error,
    Aborted,
    Rejected,
}

impl ToolStatus {
    /// The wire form: the exact string stored in `tool_result.status`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Aborted => "aborted",
            Self::Rejected => "rejected",
        }
    }
}

impl std::fmt::Display for ToolStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ToolStatus {
    type Err = UnknownToolStatus;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "ok" => Ok(Self::Ok),
            "error" => Ok(Self::Error),
            "aborted" => Ok(Self::Aborted),
            "rejected" => Ok(Self::Rejected),
            _ => Err(UnknownToolStatus),
        }
    }
}

/// Rejection for anything outside the four stored statuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownToolStatus;

impl std::fmt::Display for UnknownToolStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("unknown tool status (want ok|error|aborted|rejected)")
    }
}

impl std::error::Error for UnknownToolStatus {}

/// Identity of one model. `provider` is the models.dev provider key
/// (`anthropic`), not a display name (`CONTRACTS.md` §5, D23).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
}

/// What the picker shows and what the request builder reserves. All counts
/// are tokens. Keys mirror the catalogue subset the picker consumes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelLimits {
    #[serde(rename = "contextWindow")]
    pub context_window: u64,
    #[serde(rename = "maxOutput")]
    pub max_output: u64,
    pub reasoning: bool,
    pub tool_call: bool,
}

/// An unknown model degrades to this, never a panic and never a zero-limit
/// guess: zero is a measurement, unknown is the absence of one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnknownModel {
    pub kind: String,
    #[serde(rename = "ref")]
    pub model: ModelRef,
}

impl UnknownModel {
    #[must_use]
    pub fn for_ref(model: ModelRef) -> Self {
        Self {
            kind: "unknown-model".to_string(),
            model,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_behaves() {
        // No serde_json here on purpose: this crate depends on nothing but
        // `serde`, and the test must not smuggle in a second dependency.
        let p = Placeholder {
            name: "headless".to_string(),
        };
        assert_eq!(p.clone(), p);
        assert!(format!("{p:?}").contains("headless"));
    }
}
