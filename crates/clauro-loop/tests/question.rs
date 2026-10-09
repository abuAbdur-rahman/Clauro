//! Task 009 — answerable questions (RED).
//!
//! Today a `question` call is dispatched like any other tool: the handler's
//! `Ok` becomes an ordinary `tool_result` and the loop re-sends with the
//! card text echoed back as if the user answered. The user is never asked.
//!
//! The contract this file pins (DESIGN §2.3 — the turn visibly pauses at the
//! point of the question):
//! - a sole, valid `question` call ends the turn as `AwaitingAnswer` with
//!   the call id, persisting the `tool_use` plus a `question_card` block and
//!   NO `tool_result` yet;
//! - `answer_question` validates through `resolve_answer` and persists the
//!   answer as the call's one `tool_result` (I1 holds exactly once answered);
//! - answering twice, answering unknown ids, and answering free text on a
//!   closed card all fail typed — never a second result row, never silence;
//! - refused questions (mixed/second/secret) keep their refusal result rows
//!   and never pause: nothing to answer, nothing held.

use clauro_loop::run::{Exchange, ExchangeFailure, PreparedThread, TurnEnd, TurnLoop, TurnPlan};
use clauro_store::{NewProject, NewThread, Store};
use clauro_tools::Registry;
use clauro_transport::{BuiltRequest, InboundKind, NormalisedEvent, ToolHeader};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn fresh() -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("clauro-009-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).expect("scratch");
        Self { path }
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

struct Script {
    steps: VecDeque<Vec<NormalisedEvent>>,
}

impl Script {
    fn new(steps: Vec<Vec<NormalisedEvent>>) -> Self {
        Self {
            steps: steps.into_iter().collect(),
        }
    }
}

impl Exchange for Script {
    fn step(
        &mut self,
        _request: &BuiltRequest,
        sink: &mut dyn FnMut(NormalisedEvent),
    ) -> Result<Vec<NormalisedEvent>, ExchangeFailure> {
        let events = self.steps.pop_front().expect("script exhausted");
        for event in &events {
            sink(event.clone());
        }
        Ok(events)
    }
}

fn question_step(id: &str, input: &str) -> Vec<NormalisedEvent> {
    vec![
        NormalisedEvent::BlockStart {
            index: 0,
            kind: InboundKind::ToolUse,
            tool: Some(ToolHeader {
                id: id.to_string(),
                name: "question".to_string(),
            }),
        },
        NormalisedEvent::BlockDelta {
            index: 0,
            text: Some(input.to_string()),
            signature: None,
        },
        NormalisedEvent::BlockStop { index: 0 },
    ]
}

fn text_step(text: &str) -> Vec<NormalisedEvent> {
    vec![
        NormalisedEvent::BlockStart {
            index: 0,
            kind: InboundKind::Text,
            tool: None,
        },
        NormalisedEvent::BlockDelta {
            index: 0,
            text: Some(text.to_string()),
            signature: None,
        },
        NormalisedEvent::BlockStop { index: 0 },
    ]
}

fn seeded(dir: &TestDir, hash: &str) -> Store {
    let store = Store::open(&dir.path.join("s.db")).expect("store");
    store
        .insert_project(NewProject {
            id: "p1".into(),
            name: "P".into(),
            instructions: String::new(),
            bash_enabled: false,
        })
        .expect("project");
    store
        .insert_thread(NewThread {
            id: "t1".to_string(),
            project_id: Some("p1".into()),
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: hash.to_string(),
            tools_frozen: String::new(),
        })
        .expect("thread");
    store
}

fn prepared(hash: &str) -> PreparedThread {
    PreparedThread {
        system_text: "s".into(),
        frozen_hash: hash.to_string(),
        model: "m".into(),
        max_tokens: 1024,
        tools: Vec::new(),
        thinking_budget: 0,
        rules: Vec::new(),
    }
}

fn bound_registry(loop_: &mut TurnLoop) -> Registry {
    let mut reg = Registry::with_eight();
    let gate = loop_.question_gate("t1");
    clauro_tools::register_question_with_gate(&mut reg, gate);
    reg
}

const CARD_INPUT: &str = r#"{"prompt":"which one?","options":[{"id":"a","label":"A"}]}"#;
/// Closed card: free text off, so only listed ids validate.
const CARD_CLOSED: &str =
    r#"{"prompt":"pick one","options":[{"id":"a","label":"A"}],"allowFreeText":false}"#;

/// A sole valid question pauses the turn instead of echoing the card back.
#[test]
fn sole_question_ends_the_turn_awaiting_answer() {
    let dir = TestDir::fresh();
    let store = seeded(&dir, "h");
    let prep = prepared("h");
    let mut loop_ = TurnLoop::new();
    let mut reg = bound_registry(&mut loop_);
    let mut ex = Script::new(vec![question_step("call-q", CARD_INPUT)]);

    let report = loop_
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prep,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn runs");

    assert_eq!(report.end, TurnEnd::AwaitingAnswer);
    assert_eq!(report.pending_question.as_deref(), Some("call-q"));
    // The card is persisted and answerable; no result exists yet.
    let blocks = store.blocks_for_thread("t1");
    assert!(
        blocks.iter().any(|b| b.kind == "question_card"),
        "a question_card row must exist"
    );
    assert!(
        blocks.iter().all(|b| b.kind != "tool_result"),
        "no tool_result may exist before the user answers"
    );
}

/// Answering persists exactly one result; I1 holds once answered.
#[test]
fn answer_persists_the_calls_one_result() {
    let dir = TestDir::fresh();
    let store = seeded(&dir, "h");
    let prep = prepared("h");
    let mut loop_ = TurnLoop::new();
    let mut reg = bound_registry(&mut loop_);
    let mut ex = Script::new(vec![question_step("call-q", CARD_INPUT)]);
    loop_
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prep,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn runs");

    let resolution = loop_
        .answer_question(&store, "t1", "call-q", "a")
        .expect("answer validates");

    assert_eq!(resolution.card_id, "call-q");
    assert_eq!(resolution.resolved, "a");
    let results: Vec<_> = store
        .blocks_for_thread("t1")
        .into_iter()
        .filter(|b| b.kind == "tool_result")
        .collect();
    assert_eq!(results.len(), 1, "exactly one result row for the call");
}

/// A second answer to the same card fails typed — never a second row.
#[test]
fn answering_twice_fails_typed() {
    let dir = TestDir::fresh();
    let store = seeded(&dir, "h");
    let prep = prepared("h");
    let mut loop_ = TurnLoop::new();
    let mut reg = bound_registry(&mut loop_);
    let mut ex = Script::new(vec![question_step("call-q", CARD_INPUT)]);
    loop_
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prep,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn runs");
    loop_
        .answer_question(&store, "t1", "call-q", "a")
        .expect("first answer");
    let err = loop_
        .answer_question(&store, "t1", "call-q", "a")
        .expect_err("second answer must fail");
    assert!(
        matches!(err, clauro_loop::run::AnswerError::AlreadyAnswered(_)),
        "typed AlreadyAnswered, never a second row: {err:?}"
    );
}

/// Unknown ids and closed-card free text fail typed, never silently.
#[test]
fn unknown_or_invalid_answers_fail_typed() {
    let dir = TestDir::fresh();
    let store = seeded(&dir, "h");
    let prep = prepared("h");
    let mut loop_ = TurnLoop::new();
    let mut reg = bound_registry(&mut loop_);
    // Closed card: only "a" validates; free text is off.
    let mut ex = Script::new(vec![question_step("call-q", CARD_CLOSED)]);
    loop_
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prep,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn runs");

    assert!(
        matches!(
            loop_.answer_question(&store, "t1", "nope", "a"),
            Err(clauro_loop::run::AnswerError::NoSuchCard(_))
        ),
        "unknown call id fails typed"
    );
    assert!(
        loop_
            .answer_question(&store, "t1", "call-q", "invented")
            .is_err(),
        "an option outside a closed card fails"
    );
    assert!(
        loop_
            .answer_question(&store, "t1", "call-q", "   ")
            .is_err(),
        "blank answers fail"
    );
}

/// A refused question (second in its turn) keeps its refusal row and never
/// pauses: nothing to answer, nothing held.
#[test]
fn refused_questions_never_pause() {
    let dir = TestDir::fresh();
    let store = seeded(&dir, "h");
    let prep = prepared("h");
    let mut loop_ = TurnLoop::new();
    let mut reg = bound_registry(&mut loop_);
    let mut first = question_step("call-1", CARD_INPUT);
    first.extend(question_step("call-2", CARD_INPUT));
    // Refusals do not end the turn: the loop re-sends with both refusals
    // persisted, so the script supplies the closing text step.
    let mut ex = Script::new(vec![first, text_step("done")]);
    let report = loop_
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prep,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn runs");

    assert_eq!(report.end, TurnEnd::EndTurn);
    assert_eq!(report.pending_question, None);
    // The refusal path from 009 is untouched: refusal rows, no cards.
    let blocks = store.blocks_for_thread("t1");
    assert!(
        blocks.iter().all(|b| b.kind != "question_card"),
        "refused questions produce no card"
    );
}

/// After an answer, the turn continues to EndTurn instead of stalling.
#[test]
fn answered_turn_continues_to_end_turn() {
    let dir = TestDir::fresh();
    let store = seeded(&dir, "h");
    let prep = prepared("h");
    let mut loop_ = TurnLoop::new();
    let mut reg = bound_registry(&mut loop_);
    let mut ex = Script::new(vec![question_step("call-q", CARD_INPUT)]);
    let report = loop_
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prep,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn runs");
    assert_eq!(report.end, TurnEnd::AwaitingAnswer);
    loop_
        .answer_question(&store, "t1", "call-q", "a")
        .expect("answer");

    let mut ex2 = Script::new(vec![text_step("thanks, moving on")]);
    let report2 = loop_
        .continue_turn(
            &store,
            &mut reg,
            &mut ex2,
            "t1",
            &prep,
            &dir.path,
            &mut |_| {},
        )
        .expect("continue runs");
    assert_eq!(report2.end, TurnEnd::EndTurn);
}
