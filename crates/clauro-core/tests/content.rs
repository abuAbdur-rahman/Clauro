//! Task 006 — the content-block union every view renders (RED).
//!
//! One shape for both providers (D54). `input` crosses as canonical JSON
//! text: this crate stays serde-only by mechanical test, and the store layer
//! parses where validation lives.

use clauro_core::{ContentBlock, ThinkingDisplay};

#[test]
fn thinking_requires_a_signature() {
    assert!(
        ContentBlock::thinking("hmm", "", ThinkingDisplay::Full).is_err(),
        "a thinking block without signature fails verification on replay (D72)"
    );
    let block = ContentBlock::thinking("hmm", "sig-1", ThinkingDisplay::Full)
        .expect("signature present must build");
    assert!(matches!(block, ContentBlock::Thinking { .. }));
}

#[test]
fn omitted_thinking_is_a_valid_thinking_block() {
    // D73: empty text, real signature — valid, not malformed.
    let block = ContentBlock::thinking("", "sig-abc", ThinkingDisplay::Summary)
        .expect("omitted thinking must build");
    assert!(matches!(
        block,
        ContentBlock::Thinking {
            display: ThinkingDisplay::Summary,
            ..
        }
    ));
}

#[test]
fn union_round_trips_with_kind_tags() {
    let blocks = vec![
        ContentBlock::Text {
            text: "hi".to_string(),
        },
        ContentBlock::thinking("t", "s", ThinkingDisplay::Full).expect("sig"),
        ContentBlock::ToolUse {
            id: "c1".to_string(),
            name: "fs".to_string(),
            input_json: "{}".to_string(),
        },
        ContentBlock::ToolResult {
            tool_use_id: "c1".to_string(),
            status: clauro_core::ToolStatus::Ok,
            preview: "p".to_string(),
            preview_path: None,
        },
        ContentBlock::ArtifactRef {
            artifact_id: "a".to_string(),
            version: 1,
            title: "demo".to_string(),
        },
        ContentBlock::QuestionCard {
            id: "q".to_string(),
            prompt: "pick".to_string(),
            options: vec![],
            allow_free_text: true,
            resolved: None,
        },
        ContentBlock::Summary {
            text: "s".to_string(),
            boundary: 4,
            generation: 1,
        },
        ContentBlock::Compaction {
            provider_block_id: "b".to_string(),
        },
        ContentBlock::Notice {
            level: clauro_core::NoticeLevel::Warn,
            text: "dropped".to_string(),
        },
    ];
    for block in blocks {
        let json = serde_json::to_string(&block).expect("must serialise");
        let back: ContentBlock = serde_json::from_str(&json).expect("must parse");
        assert_eq!(block, back);
    }
}

#[test]
fn unbroken_run_end_finds_the_first_gap() {
    use clauro_core::unbroken_run_end;
    assert_eq!(unbroken_run_end(&[true, true, true]), 3);
    assert_eq!(unbroken_run_end(&[true, false, true]), 1);
    assert_eq!(unbroken_run_end(&[false, true]), 0);
    assert_eq!(unbroken_run_end(&[]), 0);
}

#[test]
fn deserialization_rejects_empty_signatures() {
    // CodeRabbit PR #3: derive(Deserialize) bypassed the constructor check,
    // and persisted/wire payloads take the deserialize path.
    let bad = r#"{"kind":"thinking","text":"x","signature":"","display":"full"}"#;
    assert!(
        serde_json::from_str::<ContentBlock>(bad).is_err(),
        "empty signature must fail on the deserialize path too (D72)"
    );
    let good = r#"{"kind":"thinking","text":"x","signature":"s","display":"full"}"#;
    assert!(serde_json::from_str::<ContentBlock>(good).is_ok());
}
