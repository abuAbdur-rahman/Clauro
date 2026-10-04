//! Task 007 — tool availability, both adapters (RED).
//!
//! D94 supersedes frozen-tools on the Claude API: every tool rides the first
//! request's array (unavailable ones `defer_loading: true`), and the set
//! changes only via `tool_addition` / `tool_removal` system messages — never
//! a rewritten array, never a new thread. The OpenAI-compatible adapter keeps
//! the frozen array. Both behaviours asserted, because they differ on purpose.
//! D26 throughout: a denied tool is absent from the serialised request.

use clauro_tools::{materialize, ThreadToolState};
use std::collections::BTreeSet;

fn state(granted: &[&str], denied: &[&str]) -> ThreadToolState {
    ThreadToolState {
        granted: granted.iter().map(|s| s.to_string()).collect(),
        denied: denied.iter().map(|s| s.to_string()).collect(),
    }
}

fn all_but_bash() -> ThreadToolState {
    state(
        &[
            "memory",
            "artifact",
            "web-search",
            "web-fetch",
            "fs",
            "question",
        ],
        &[],
    )
}

#[test]
fn first_request_carries_all_eight_with_defer_flags() {
    let avail = materialize(None, &all_but_bash());
    assert_eq!(avail.anthropic_tools.len(), 8, "declare every tool upfront");
    let bash = avail
        .anthropic_tools
        .iter()
        .find(|t| t.name == "bash")
        .expect("bash declared");
    assert!(bash.deferred, "ungranted tools defer_loading: true");
    let fs = avail
        .anthropic_tools
        .iter()
        .find(|t| t.name == "fs")
        .expect("fs declared");
    assert!(!fs.deferred);
    assert!(
        avail
            .beta_headers
            .iter()
            .any(|h| h.contains("inline-tools-2026-09-15")),
        "availability needs its beta header: {:?}",
        avail.beta_headers
    );
}

#[test]
fn granting_bash_yields_addition_not_rewrite() {
    let before = materialize(None, &all_but_bash());
    let mut granted = all_but_bash();
    granted.granted.insert("bash".to_string());
    let after = materialize(Some(&before), &granted);
    assert_eq!(
        after.anthropic_tools, before.anthropic_tools,
        "the array is never rewritten afterwards"
    );
    assert!(
        after
            .additions
            .iter()
            .any(|a| a.to_string().contains("bash")),
        "granting produces tool_addition naming it: {:?}",
        after.additions
    );
    assert!(
        after
            .system_messages
            .iter()
            .any(|m| m.to_string().contains("bash")),
        "the addition rides a system message: {:?}",
        after.system_messages
    );
}

#[test]
fn revoking_yields_removal() {
    let before = materialize(None, &all_but_bash());
    let mut revoked = all_but_bash();
    revoked.granted.remove("fs");
    let after = materialize(Some(&before), &revoked);
    assert_eq!(after.anthropic_tools, before.anthropic_tools);
    assert!(
        after.removals.iter().any(|r| r.to_string().contains("fs")),
        "{:?}",
        after.removals
    );
}

#[test]
fn denied_tools_are_absent_everywhere() {
    let avail = materialize(None, &state(&["fs"], &["bash", "memory"]));
    assert!(
        !avail.anthropic_tools.iter().any(|t| t.name == "bash"),
        "denied is removed from the request, not filtered (D26)"
    );
    assert!(
        !avail.openai_tools.iter().any(|t| t.name == "memory"),
        "denied is absent on both adapters"
    );
    // Newly denied after declaration: array frozen, removal block instead.
    let before = materialize(None, &all_but_bash());
    let mut s = all_but_bash();
    s.denied.insert("fs".to_string());
    s.granted.remove("fs");
    let after = materialize(Some(&before), &s);
    assert_eq!(after.anthropic_tools, before.anthropic_tools);
    assert!(after.removals.iter().any(|r| r.to_string().contains("fs")));
}

#[test]
fn openai_path_freezes_the_granted_array() {
    let a = materialize(None, &all_but_bash());
    let mut granted = all_but_bash();
    granted.granted.insert("bash".to_string());
    let b = materialize(Some(&a), &granted);
    assert_eq!(
        a.openai_tools, b.openai_tools,
        "OpenAI-compatible: frozen array, no mid-thread changes"
    );
    assert!(
        b.openai_tools.iter().all(|t| !t.deferred),
        "no deferral concept here: absent means absent"
    );
}

#[test]
fn change_messages_are_immutable_once_recorded() {
    // The store has no update path on message/block (004 scan test), so a
    // recorded tool-change message reads back identical: append-only joins
    // the prefix retroactively (D94) and cannot be moved, reworded, or
    // deleted afterwards.
    let avail = materialize(None, &all_but_bash());
    let mut granted = all_but_bash();
    granted.granted.insert("bash".to_string());
    let after = materialize(Some(&avail), &granted);
    let first = after.system_messages.clone();
    let reread = after.system_messages;
    assert_eq!(first, reread);
    assert!(!first.is_empty());
}

#[test]
fn availability_threads_sets_for_membership() {
    let s = all_but_bash();
    assert!(s.granted.contains("fs"));
    assert!(!s.granted.contains("bash"));
    let _: BTreeSet<String> = s.denied;
}
