//! Task 007 — registry: fixed eight, stale calls, zero throws (RED).
//!
//! D108: the set is fixed at eight; no code loads at runtime — registering a
//! ninth name or binding an unknown name fails. D19: `materialize()` captures
//! identity; `settle()` on a stale epoch is a typed error, not a dispatch.
//! D55: every path out of `dispatch` is a `ToolOutcome`, including panics and
//! malformed input.

use clauro_core::{ToolContext, ToolOutcome};
use clauro_tools::{IncomingCall, Registry};
use serde_json::json;
use std::path::PathBuf;

fn ctx() -> ToolContext {
    ToolContext {
        thread_id: "t1".to_string(),
        call_id: "c1".to_string(),
        workspace_dir: PathBuf::from("/tmp/ws"),
    }
}

#[test]
fn registry_holds_exactly_the_fixed_eight() {
    let names = Registry::with_eight().names();
    assert_eq!(names.len(), 8, "{names:?}");
    for tool in [
        "memory",
        "artifact",
        "web-search",
        "web-fetch",
        "fs",
        "compact",
        "bash",
        "question",
    ] {
        assert!(names.contains(&tool.to_string()), "{names:?}");
    }
}

#[test]
fn ninth_tool_and_unknown_binding_are_rejected() {
    let mut reg = Registry::with_eight();
    assert!(
        reg.register("plugin-x", "extra", json!({}), false).is_err(),
        "the set is fixed at eight (D108)"
    );
    assert!(
        reg.set_handler("plugin-x", |_, _| ToolOutcome::Error {
            message: "x".to_string()
        })
        .is_err(),
        "no runtime tool loading (D108)"
    );
}

#[test]
fn stale_epoch_never_dispatches() {
    let mut reg = Registry::with_eight();
    reg.set_handler("fs", |_, _| ToolOutcome::Error {
        message: "handled".to_string(),
    })
    .expect("known tool binds");
    let first = reg.materialize();
    let second = reg.materialize();
    assert_ne!(first.epoch, second.epoch);
    let stale = reg.dispatch(
        &IncomingCall {
            name: "fs".to_string(),
            input: json!({}),
            epoch: first.epoch,
        },
        &ctx(),
    );
    assert!(
        matches!(stale, ToolOutcome::Error { ref message } if message.contains("Stale")),
        "stale identity must not reach the handler: {stale:?}"
    );
    let fresh = reg.dispatch(
        &IncomingCall {
            name: "fs".to_string(),
            input: json!({}),
            epoch: second.epoch,
        },
        &ctx(),
    );
    assert!(
        matches!(fresh, ToolOutcome::Error { ref message } if message == "handled"),
        "{fresh:?}"
    );
}

#[test]
fn unknown_tool_is_a_typed_error() {
    let mut reg = Registry::with_eight();
    let m = reg.materialize();
    let out = reg.dispatch(
        &IncomingCall {
            name: "plugin-x".to_string(),
            input: json!({}),
            epoch: m.epoch,
        },
        &ctx(),
    );
    assert!(matches!(out, ToolOutcome::Error { .. }), "{out:?}");
}

#[test]
fn unbound_handler_is_a_typed_error() {
    let mut reg = Registry::with_eight();
    let m = reg.materialize();
    let out = reg.dispatch(
        &IncomingCall {
            name: "memory".to_string(),
            input: json!({}),
            epoch: m.epoch,
        },
        &ctx(),
    );
    assert!(
        matches!(out, ToolOutcome::Error { ref message } if message.contains("memory")),
        "008 owns the handler; 007 reports its absence: {out:?}"
    );
}

#[test]
fn panicking_handler_becomes_error_not_panic() {
    let mut reg = Registry::with_eight();
    reg.set_handler("fs", |_, _| panic!("boom")).expect("binds");
    let m = reg.materialize();
    let out = reg.dispatch(
        &IncomingCall {
            name: "fs".to_string(),
            input: json!({}),
            epoch: m.epoch,
        },
        &ctx(),
    );
    assert!(
        matches!(out, ToolOutcome::Error { .. }),
        "nothing throws across the boundary (D55): {out:?}"
    );
}

#[test]
fn malformed_input_is_a_typed_error() {
    let mut reg = Registry::with_eight();
    reg.set_handler("fs", |input, _| {
        input
            .get("path")
            .and_then(|p| p.as_str())
            .map(|p| ToolOutcome::Error {
                message: format!("no such file: {p}"),
            })
            .unwrap_or(ToolOutcome::Error {
                message: "missing path".to_string(),
            })
    })
    .expect("binds");
    let m = reg.materialize();
    let out = reg.dispatch(
        &IncomingCall {
            name: "fs".to_string(),
            input: json!({"wrong": 1}),
            epoch: m.epoch,
        },
        &ctx(),
    );
    assert!(matches!(out, ToolOutcome::Error { .. }), "{out:?}");
}
