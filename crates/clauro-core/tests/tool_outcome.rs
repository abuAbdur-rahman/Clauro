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

/// One conversion, exhaustively matched — the consumer's catch-all
/// `_ => Error` diverges from this (review 22): a future variant must fail
/// to compile here rather than persist as the wrong status somewhere.
#[test]
fn status_conversion_covers_every_variant() {
    use clauro_core::ToolStatus;
    assert_eq!(
        ToolStatus::from(&ToolOutcome::Ok {
            preview: "p".to_string(),
            preview_path: None,
            full_path: None,
        }),
        ToolStatus::Ok
    );
    assert_eq!(
        ToolStatus::from(&ToolOutcome::Error {
            message: "x".to_string()
        }),
        ToolStatus::Error
    );
    assert_eq!(
        ToolStatus::from(&ToolOutcome::Aborted {
            message: "x".to_string()
        }),
        ToolStatus::Aborted
    );
    assert_eq!(
        ToolStatus::from(&ToolOutcome::Rejected {
            message: "x".to_string()
        }),
        ToolStatus::Rejected
    );
}

/// The wire form is pinned (CONTRACTS §3): internally tagged on `status`,
/// lowercase, and `None` options skipped — never `null` — which is where the
/// sibling `ContentBlock` shape differs. Any drift here surfaces at the
/// Tauri/TS boundary; better it surfaces here.
#[test]
fn wire_form_is_pinned() {
    let ok = ToolOutcome::Ok {
        preview: "p".to_string(),
        preview_path: None,
        full_path: None,
    };
    let v = serde_json::to_value(&ok).expect("serialises");
    assert_eq!(v, serde_json::json!({"status": "ok", "preview": "p"}));
    let back: ToolOutcome = serde_json::from_value(v).expect("round-trips");
    assert_eq!(back, ok);

    let with_path = ToolOutcome::Ok {
        preview: "p".to_string(),
        preview_path: Some("/tmp/x".to_string()),
        full_path: None,
    };
    let v = serde_json::to_value(&with_path).expect("serialises");
    assert_eq!(
        v,
        serde_json::json!({"status": "ok", "preview": "p", "preview_path": "/tmp/x"})
    );

    let err = ToolOutcome::Error {
        message: "boom".to_string(),
    };
    let v = serde_json::to_value(&err).expect("serialises");
    assert_eq!(v, serde_json::json!({"status": "error", "message": "boom"}));
    let back: ToolOutcome = serde_json::from_value(v).expect("round-trips");
    assert_eq!(back, err);
}
