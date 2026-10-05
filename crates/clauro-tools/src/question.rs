//! The `question` tool: one inline card per turn, secrets never (D40–D43).
//!
//! First-class tool, not prose (D40): the answer validates here and the loop
//! persists it as an ordinary `tool_result`, so the card survives compaction
//! with no special handling. Inline, never a modal (D41 — both MIT references
//! do the opposite; this divergence is deliberate).
//!
//! Two rules, one silent message (D42, D43, D101): a second question call, a
//! question beside any other call, a secret-shaped prompt, and a malformed
//! card all fail with the identical refusal, so the model cannot learn which
//! rule tripped by probing. The per-turn gate is shared state: the handler
//! records its own invocations, the loop records every other dispatch via
//! `note_call` and resets per assistant message (023's seam).

use crate::secret::looks_secret;
use clauro_core::{ToolContext, ToolOutcome};
use serde_json::Value;
use std::fmt;
use std::sync::{Arc, Mutex};

/// The single refusal every question failure returns. Identical by design.
pub const QUESTION_REFUSAL: &str = "question not accepted";

/// Skip is always offered (D42): appended when the model omits it.
pub const SKIP_ID: &str = "skip";
const SKIP_LABEL: &str = "Skip / decide for me";

#[derive(Debug, Default)]
struct GateState {
    questions_asked: u32,
    other_calls: bool,
}

/// Per-turn question gate. Clone shares the same turn state.
#[derive(Debug, Clone, Default)]
pub struct QuestionGate {
    state: Arc<Mutex<GateState>>,
}

impl QuestionGate {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one dispatched call in this turn. The loop calls this for every
    /// non-question dispatch; the question handler records itself.
    pub fn note_call(&self, name: &str) {
        let mut state = self.state.lock().expect("gate lock must hold");
        if name == "question" {
            state.questions_asked += 1;
        } else {
            state.other_calls = true;
        }
    }

    /// Open the next assistant turn.
    pub fn reset(&self) {
        *self.state.lock().expect("gate lock must hold") = GateState::default();
    }

    /// True when another question call, or any other call, already landed
    /// this turn — i.e. this question must be refused (D42, D101).
    fn must_refuse(&self) -> bool {
        let state = self.state.lock().expect("gate lock must hold");
        state.questions_asked >= 1 || state.other_calls
    }
}

/// A validated user answer, ready to persist as an ordinary `tool_result`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnswerResolution {
    pub card_id: String,
    pub resolved: String,
}

/// Why an answer was rejected. Typed; the UI shows these, the model never does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuestionError {
    MalformedCard,
    EmptyAnswer,
    UnknownOption(String),
}

impl fmt::Display for QuestionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MalformedCard => f.write_str("question card malformed"),
            Self::EmptyAnswer => f.write_str("answer must not be empty"),
            Self::UnknownOption(o) => write!(f, "unknown option: {o}"),
        }
    }
}

impl std::error::Error for QuestionError {}

fn refusal() -> ToolOutcome {
    ToolOutcome::Error {
        message: QUESTION_REFUSAL.to_string(),
    }
}

/// Validate a submitted answer against its card. Free text passes when the
/// card allows it; otherwise the answer must name a listed option id.
pub fn resolve_answer(card: &Value, resolved: &str) -> Result<AnswerResolution, QuestionError> {
    let card_id = card
        .get("id")
        .and_then(Value::as_str)
        .ok_or(QuestionError::MalformedCard)?
        .to_string();
    if resolved.trim().is_empty() {
        return Err(QuestionError::EmptyAnswer);
    }
    let allow_free = card
        .get("allowFreeText")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let options: Vec<String> = card
        .get("options")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|o| o.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if !allow_free && !options.is_empty() && !options.iter().any(|o| o == resolved) {
        return Err(QuestionError::UnknownOption(resolved.to_string()));
    }
    Ok(AnswerResolution {
        card_id,
        resolved: resolved.to_string(),
    })
}

fn present_card(prompt: &str, options: &[(String, String)]) -> String {
    let mut out = format!("Question: {prompt}\n");
    for (id, label) in options {
        out.push_str(&format!("- [{id}] {label}\n"));
    }
    out
}

/// Bind the `question` handler and return the turn gate. The gate outlives
/// the call: the loop holds it for `note_call` / `reset`.
pub fn register_question(reg: &mut crate::registry::Registry) -> QuestionGate {
    let gate = QuestionGate::new();
    let gate_in_handler = gate.clone();
    let _ = reg.set_handler("question", move |input: &Value, _ctx: &ToolContext| {
        let prompt = input.get("prompt").and_then(Value::as_str).unwrap_or("");
        if prompt.trim().is_empty() {
            return refusal();
        }
        if looks_secret(prompt) {
            return refusal();
        }
        if gate_in_handler.must_refuse() {
            return refusal();
        }
        gate_in_handler.note_call("question");
        let mut options: Vec<(String, String)> = input
            .get("options")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|o| {
                        Some((
                            o.get("id")?.as_str()?.to_string(),
                            o.get("label")?.as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !options.iter().any(|(id, _)| id == SKIP_ID) {
            options.push((SKIP_ID.to_string(), SKIP_LABEL.to_string()));
        }
        ToolOutcome::Ok {
            preview: present_card(prompt, &options),
            preview_path: None,
            full_path: None,
        }
    });
    gate
}
