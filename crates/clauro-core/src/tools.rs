//! Tool-contract types (`CONTRACTS.md` §3).
//!
//! Nothing throws across the tool boundary (D55): every handler returns a
//! `ToolOutcome`, and a non-zero exit is `ok` with output attached.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;

/// What a tool call returns. All four are results, never exceptions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ToolOutcome {
    Ok {
        preview: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        preview_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        full_path: Option<String>,
    },
    Error {
        message: String,
    },
    /// Cancelled by the user (D65, D68).
    Aborted {
        message: String,
    },
    /// The user declined (D66).
    Rejected {
        message: String,
    },
}

impl ToolOutcome {
    /// Wire status string.
    #[must_use]
    pub fn status_str(&self) -> &'static str {
        match self {
            Self::Ok { .. } => "ok",
            Self::Error { .. } => "error",
            Self::Aborted { .. } => "aborted",
            Self::Rejected { .. } => "rejected",
        }
    }
}

/// What a handler sees. Paths are host-resolved; prompts are advisory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolContext {
    pub thread_id: String,
    pub call_id: String,
    /// Clauro-owned workspace root. The model never sees this raw.
    pub workspace_dir: PathBuf,
}

/// One permission rule. Resolution is two pure stages in `clauro-tools`:
/// fold per effect (last matching rule of each effect wins — ported,
/// OpenCode `findLast`), then fail-closed precedence deny > ask > allow
/// (Clauro-original, D26).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    Deny,
    Ask,
    Allow,
}

/// The default when no rule matches.
pub const DEFAULT_EFFECT: Effect = Effect::Allow;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionRule {
    pub effect: Effect,
    pub tool: String,
}

impl fmt::Display for Effect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Deny => f.write_str("deny"),
            Self::Ask => f.write_str("ask"),
            Self::Allow => f.write_str("allow"),
        }
    }
}
