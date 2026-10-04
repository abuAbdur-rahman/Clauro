//! Task 005 — the capability probe needs no live key (RED).
//!
//! `capabilities.compaction` decides the compaction path at runtime (D75,
//! D81). The network fetch is one thin call; the decision is this pure
//! function, tested against synthetic Models-API shapes.

use clauro_transport::{compaction_path, CompactionPath};
use serde_json::json;

#[test]
fn probe_reads_threshold_on_demand_and_none() {
    assert!(matches!(
        compaction_path(&json!({"capabilities": {"compaction": "threshold"}})),
        CompactionPath::Threshold
    ));
    assert!(matches!(
        compaction_path(&json!({"capabilities": {"compaction": "on-demand"}})),
        CompactionPath::OnDemand
    ));
    assert!(matches!(
        compaction_path(&json!({"capabilities": {"compaction": "none"}})),
        CompactionPath::None
    ));
}

#[test]
fn missing_or_bogus_degrades_to_none() {
    assert!(matches!(
        compaction_path(&json!({"capabilities": {}})),
        CompactionPath::None
    ));
    assert!(matches!(compaction_path(&json!({})), CompactionPath::None));
    let path = compaction_path(&json!({"capabilities": {"compaction": "someday"}}));
    assert!(
        matches!(path, CompactionPath::None),
        "unknown strings fail closed to client-side, never a guess"
    );
}
