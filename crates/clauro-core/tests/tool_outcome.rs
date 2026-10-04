//! Task 007 — outcome shapes (small).
use clauro_core::{Effect, ToolOutcome, DEFAULT_EFFECT};

#[test]
fn status_strings_match_the_wire() {
    assert_eq!(
        ToolOutcome::Error {
            message: "x".to_string()
        }
        .status_str(),
        "error"
    );
    assert_eq!(
        ToolOutcome::Ok {
            preview: "p".to_string(),
            preview_path: None,
            full_path: None,
        }
        .status_str(),
        "ok"
    );
    assert_eq!(
        ToolOutcome::Aborted {
            message: "x".to_string()
        }
        .status_str(),
        "aborted"
    );
    assert_eq!(
        ToolOutcome::Rejected {
            message: "x".to_string()
        }
        .status_str(),
        "rejected"
    );
    assert_eq!(DEFAULT_EFFECT, Effect::Allow);
    assert_eq!(Effect::Deny.to_string(), "deny");
}
