//! Task 004 — the four tool-result statuses are a shared core type (RED).
//!
//! `CONTRACTS.md` §1 (`tool_result.status`) and §3 (`ToolOutcome`) agree on
//! exactly four outcomes: a missing file is `error`, a cancelled call is
//! `aborted`, a declined command is `rejected`, and a non-zero exit is `ok`
//! (D55). The store persists them; the loop returns them. One enum, one place.

use clauro_core::ToolStatus;

#[test]
fn four_statuses_with_wire_names() {
    assert_eq!(ToolStatus::Ok.as_str(), "ok");
    assert_eq!(ToolStatus::Error.as_str(), "error");
    assert_eq!(ToolStatus::Aborted.as_str(), "aborted");
    assert_eq!(ToolStatus::Rejected.as_str(), "rejected");
}

#[test]
fn status_round_trips_through_parse() {
    for (text, want) in [
        ("ok", ToolStatus::Ok),
        ("error", ToolStatus::Error),
        ("aborted", ToolStatus::Aborted),
        ("rejected", ToolStatus::Rejected),
    ] {
        assert_eq!(text.parse::<ToolStatus>().expect("must parse"), want);
        assert_eq!(want.as_str(), text);
    }
    assert!("bogus".parse::<ToolStatus>().is_err());
}
