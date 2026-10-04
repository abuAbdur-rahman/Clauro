//! Capability probe: the compaction path without a live key (D75, D81).
//!
//! The Models API exposes `capabilities.compaction`; the network fetch is one
//! thin call in the shell, the decision is this pure function. Unknown or
//! missing values fail closed to client-side handling, never a guess.

use serde_json::Value;

/// The three compaction paths (D58, D75, D81).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionPath {
    /// Server compacts on ordinary requests; simplest where available.
    Threshold,
    /// Explicit compaction request with our own instructions.
    OnDemand,
    /// Neither: the client summarises and swaps the prefix itself.
    None,
}

/// Read the path out of a Models-API model object.
#[must_use]
pub fn compaction_path(model_json: &Value) -> CompactionPath {
    match model_json
        .pointer("/capabilities/compaction")
        .and_then(Value::as_str)
    {
        Some("threshold") => CompactionPath::Threshold,
        Some("on-demand") => CompactionPath::OnDemand,
        _ => CompactionPath::None,
    }
}
