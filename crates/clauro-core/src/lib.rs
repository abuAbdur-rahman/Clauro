//! `clauro-core`: domain types. No I/O, no dependencies beyond `serde`.
//!
//! The type layer (`TECH_STACK.md` §2). Anything doing I/O, touching the
//! network, or knowing Tauri exists lives in another crate. The dependency
//! rule is mechanical, not conventional: see `tests/no_extra_deps.rs`.

use serde::{Deserialize, Serialize};

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
