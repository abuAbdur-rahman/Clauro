//! Task 009 — question gate, silent refusals, skip always (RED).
//!
//! D42: one call per assistant turn, always offering skip. D101: a second
//! question call, or a question beside any other tool call in one turn, is
//! refused as a `tool_result`. D43: secret-shaped prompts refused, silently —
//! one identical message whatever tripped it, so the model cannot learn the
//! guard's shape by probing. Loop wiring (`note_call` per non-question
//! dispatch, `reset` per assistant message) is 023's seam; the question
//! handler records its own invocations.

use clauro_core::{ToolContext, ToolOutcome};
use clauro_tools::{register_question, IncomingCall, Registry};
use serde_json::json;
use std::path::PathBuf;

fn ctx() -> ToolContext {
    ToolContext {
        thread_id: "t1".to_string(),
        call_id: "c1".to_string(),
        workspace_dir: PathBuf::from("/tmp/ws"),
    }
}

fn card(prompt: &str) -> serde_json::Value {
    json!({
        "id": "q1",
        "prompt": prompt,
        "options": [{"id": "a", "label": "Alpha"}, {"id": "b", "label": "Beta"}],
        "allowFreeText": true,
    })
}

fn setup() -> (Registry, u64) {
    let mut reg = Registry::with_eight();
    register_question(&mut reg);
    let epoch = reg.materialize().epoch;
    (reg, epoch)
}

fn ask(reg: &Registry, epoch: u64, input: serde_json::Value) -> ToolOutcome {
    reg.dispatch(
        &IncomingCall {
            name: "question".to_string(),
            input,
            epoch,
        },
        &ctx(),
    )
}

#[test]
fn first_question_presented_with_skip_appended() {
    let (reg, epoch) = setup();
    match ask(&reg, epoch, card("Pick a color")) {
        ToolOutcome::Ok { preview, .. } => {
            assert!(preview.contains("Pick a color"), "{preview}");
            assert!(preview.contains("Skip"), "skip on every card: {preview}");
        }
        other => panic!("first question must present: {other:?}"),
    }
}

#[test]
fn second_question_in_turn_refused() {
    let (reg, epoch) = setup();
    assert!(matches!(
        ask(&reg, epoch, card("One?")),
        ToolOutcome::Ok { .. }
    ));
    let out = ask(&reg, epoch, card("Two?"));
    assert!(
        matches!(out, ToolOutcome::Error { .. }),
        "one per turn (D42): {out:?}"
    );
}

#[test]
fn mixed_calls_refused() {
    let mut reg = Registry::with_eight();
    let gate = register_question(&mut reg);
    let epoch = reg.materialize().epoch;
    gate.note_call("fs");
    let out = ask(&reg, epoch, card("While listing?"));
    assert!(
        matches!(out, ToolOutcome::Error { .. }),
        "question beside another call refused (D101): {out:?}"
    );
    gate.reset();
    assert!(
        matches!(
            ask(&reg, epoch, card("Fresh turn?")),
            ToolOutcome::Ok { .. }
        ),
        "reset opens the next turn"
    );
}

#[test]
fn refusals_are_identical_whatever_tripped() {
    let (reg, epoch) = setup();
    let secret = ask(
        &reg,
        epoch,
        card("Set token=sk-live-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    );
    let malformed = ask(&reg, epoch, json!({"nope": true}));
    let msg = |o: ToolOutcome| match o {
        ToolOutcome::Error { message } => message,
        other => panic!("expected refusal, got: {other:?}"),
    };
    let secret_msg = msg(secret);
    assert_eq!(secret_msg, msg(malformed), "silent: secret == malformed");
    // Cap refusal uses a fresh registry (the secret probe consumed this turn).
    let (reg2, epoch2) = setup();
    assert!(matches!(
        ask(&reg2, epoch2, card("One?")),
        ToolOutcome::Ok { .. }
    ));
    let capped = ask(&reg2, epoch2, card("Two?"));
    assert_eq!(secret_msg, msg(capped), "silent: secret == cap");
}

#[test]
fn answers_validate_against_the_card() {
    // The user's answer validates here; the loop persists it as an ordinary
    // tool_result (no special path, so compaction needs none either).
    let card_value = card("Pick");
    let ok = clauro_tools::resolve_answer(&card_value, "a").expect("known option");
    assert_eq!(ok.resolved, "a");
    assert_eq!(ok.card_id, "q1");
    assert!(clauro_tools::resolve_answer(&card_value, "").is_err());
    let strict = json!({
        "id": "q2", "prompt": "P", "options": [{"id": "a", "label": "A"}],
        "allowFreeText": false,
    });
    assert!(clauro_tools::resolve_answer(&strict, "a").is_ok());
    assert!(clauro_tools::resolve_answer(&strict, "invented").is_err());
    assert!(clauro_tools::resolve_answer(&strict, "").is_err());
}
