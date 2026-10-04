//! Task 023 — the follow-up queue and chip operations (RED).
//!
//! Sending mid-turn appends instead of blocking (D98). The queue drains as
//! in-order turns, never merged (D105). Chips remove, edit, or send-now;
//! send-now stops generation without draining, then sends that item. Stop
//! with a non-empty queue offers drain-or-discard; discard drops only unsent
//! input, never completed work.

use clauro_loop::queue::{StopOffer, ThreadQueue};

#[test]
fn queue_drains_in_order_as_separate_turns() {
    let mut q = ThreadQueue::new();
    let a = q.enqueue("first");
    let b = q.enqueue("second");
    assert_ne!(a, b);
    assert_eq!(q.len(), 2);
    let first = q.drain_next().expect("first");
    let second = q.drain_next().expect("second");
    assert_eq!(first.text, "first");
    assert_eq!(second.text, "second");
    assert_eq!(q.len(), 0);
    assert!(q.drain_next().is_none());
}

#[test]
fn chips_remove_and_edit() {
    let mut q = ThreadQueue::new();
    let a = q.enqueue("drop me");
    let b = q.enqueue("fix me");
    assert!(q.remove(&a));
    assert!(!q.remove(&a), "double remove fails");
    assert!(!q.remove("nope"), "unknown id fails");
    assert!(q.edit(&b, "fixed"));
    assert!(!q.edit("nope", "x"));
    let only = q.drain_next().expect("one left");
    assert_eq!(only.text, "fixed");
}

#[test]
fn send_now_stops_generation_without_draining() {
    let mut q = ThreadQueue::new();
    q.enqueue("waiting");
    let b = q.enqueue("urgent");
    let item = q.send_now(&b).expect("chip id extracts");
    assert_eq!(item.text, "urgent");
    // The other item stays queued: send-now never drains.
    assert_eq!(q.len(), 1);
    assert_eq!(q.drain_next().expect("still there").text, "waiting");
    assert!(q.send_now("nope").is_none());
}

#[test]
fn stop_with_queue_offers_drain_or_discard() {
    let mut q = ThreadQueue::new();
    assert!(q.stop_offer().is_none(), "empty queue: no offer");
    q.enqueue("unsent");
    assert_eq!(q.stop_offer(), Some(StopOffer::DrainOrDiscard));
}

#[test]
fn discard_drops_only_unsent_input() {
    let mut q = ThreadQueue::new();
    q.enqueue("one");
    q.enqueue("two");
    assert_eq!(q.discard_unsent(), 2);
    assert_eq!(q.len(), 0);
}
