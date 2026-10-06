//! Task 007 — approval is a typed state machine (RED).
//!
//! Queued → pending → approved → resumes, draining siblings in order; a
//! rejection becomes a typed `error` result and the loop continues with
//! nothing deleted (D109). Tests assert the states, not just that approval
//! exists.

use clauro_core::ToolOutcome;
use clauro_tools::{ApprovalQueue, ApprovalState};
use serde_json::json;

#[test]
fn held_call_walks_queued_pending_approved() {
    let mut q = ApprovalQueue::new();
    assert_eq!(
        q.hold("h1", "bash", json!({"cmd": "ls"})),
        ApprovalState::Queued
    );
    assert_eq!(
        q.mark_pending("h1").expect("pending"),
        ApprovalState::Pending
    );
    let resumed = q.approve("h1").expect("approve");
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].state, ApprovalState::Approved);
    assert_eq!(resumed[0].tool, "bash");
}

#[test]
fn approval_drains_siblings_in_order() {
    let mut q = ApprovalQueue::new();
    q.hold("h1", "bash", json!({}));
    q.hold("h2", "bash", json!({}));
    q.hold("h3", "fs", json!({}));
    q.mark_pending("h1").expect("p1");
    q.mark_pending("h2").expect("p2");
    q.mark_pending("h3").expect("p3");
    q.approve("h1").expect("a1");
    q.approve("h2").expect("a2");
    let drained = q.drain_approved();
    let ids: Vec<&str> = drained.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(ids, vec!["h1", "h2"], "FIFO, in order: {ids:?}");
    // h3 approved later still drains in its turn.
    q.approve("h3").expect("a3");
    let rest = q.drain_approved();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].id, "h3");
}

#[test]
fn rejected_call_becomes_typed_error_loop_continues() {
    let mut q = ApprovalQueue::new();
    q.hold("h1", "bash", json!({}));
    q.hold("h2", "fs", json!({}));
    q.mark_pending("h1").expect("p1");
    q.mark_pending("h2").expect("p2");
    let outcome = q.reject("h1").expect("reject");
    assert!(
        matches!(outcome, ToolOutcome::Rejected { .. }),
        "reject is a rejected result (D66): {outcome:?}"
    );
    // h2 untouched, nothing deleted.
    q.approve("h2").expect("a2");
    let drained = q.drain_approved();
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].id, "h2");
}

#[test]
fn illegal_transitions_are_typed_errors() {
    let mut q = ApprovalQueue::new();
    q.hold("h1", "bash", json!({}));
    assert!(q.approve("h1").is_err(), "queued cannot skip pending");
    assert!(q.mark_pending("nope").is_err(), "unknown id");
    assert!(q.reject("nope").is_err(), "unknown id");
    q.mark_pending("h1").expect("p1");
    q.reject("h1").expect("r1");
    assert!(q.approve("h1").is_err(), "rejected is terminal");
}
