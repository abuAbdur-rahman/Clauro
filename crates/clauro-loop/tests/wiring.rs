//! Phase-2 wiring: the loop enforces what the components prove (RED).
//!
//! `resolve()` gates every dispatch (deny → typed error, never dispatched);
//! `ask` holds into `ApprovalQueue` and resumes on a later turn; the
//! question gate sees every call with per-message reset; `Ok` previews are
//! bounded on the way out with stored paths; `compact` never reaches the
//! request schema.

use clauro_loop::prompt::first_turn_setup;
use clauro_loop::run::{Exchange, ExchangeFailure, PreparedThread, TurnEnd, TurnLoop, TurnPlan};
use clauro_store::{NewThread, Store};
use clauro_tools::{materialize, register_question_with_gate, MaterializedTool, ThreadToolState};
use clauro_transport::{BuiltRequest, InboundKind, NormalisedEvent, ToolHeader};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Trees {
    main: Store,
    tmp: PathBuf,
    session: PathBuf,
}

fn trees() -> Trees {
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let tmp = std::env::temp_dir().join(format!("clauro-wiring-{}-{n}", std::process::id()));
    let session = tmp.join("sessions").join("s1-t");
    std::fs::create_dir_all(&session).expect("session");
    let main = Store::open(&tmp.join("test.db")).expect("db");
    main.insert_project(clauro_store::NewProject {
        id: "p1".to_string(),
        name: "p".to_string(),
        instructions: String::new(),
        bash_enabled: false,
    })
    .expect("project");
    Trees { main, tmp, session }
}

impl Drop for Trees {
    fn drop(&mut self) {
        for _ in 0..25 {
            match std::fs::remove_dir_all(&self.tmp) {
                Ok(()) => return,
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
            }
        }
    }
}

struct Script {
    steps: VecDeque<Vec<NormalisedEvent>>,
    pub bodies: Vec<serde_json::Value>,
}

impl Exchange for Script {
    fn step(&mut self, request: &BuiltRequest) -> Result<Vec<NormalisedEvent>, ExchangeFailure> {
        self.bodies.push(request.body.clone());
        Ok(self.steps.pop_front().expect("script exhausted"))
    }
}

fn tool_step(id: &str, name: &str, input: &str) -> Vec<NormalisedEvent> {
    vec![
        NormalisedEvent::BlockStart {
            index: 0,
            kind: InboundKind::ToolUse,
            tool: Some(ToolHeader {
                id: id.to_string(),
                name: name.to_string(),
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
        NormalisedEvent::Stop {
            reason: "end_turn".to_string(),
        },
    ]
}

fn prepared_with(
    granted: &[&str],
    rules: Vec<clauro_core::PermissionRule>,
) -> (PreparedThread, String) {
    let defs = clauro_tools::eight_definitions();
    let (system_text, frozen_hash) = first_turn_setup(&defs, None);
    let mut state = ThreadToolState::default();
    for g in granted {
        state.granted.insert(g.to_string());
    }
    let tools: Vec<MaterializedTool> = materialize(None, &state).anthropic_tools;
    (
        PreparedThread {
            system_text,
            frozen_hash: frozen_hash.clone(),
            model: "claude-x".to_string(),
            max_tokens: 1024,
            tools,
            thinking_budget: 10_000,
            rules,
        },
        frozen_hash,
    )
}

fn seed_thread(store: &Store, frozen: &str) {
    store
        .insert_thread(NewThread {
            id: "t1".to_string(),
            project_id: Some("p1".to_string()),
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: frozen.to_string(),
            tools_frozen: "[]".to_string(),
        })
        .expect("thread");
}

fn deny(tool: &str) -> clauro_core::PermissionRule {
    clauro_core::PermissionRule {
        effect: clauro_core::Effect::Deny,
        tool: tool.to_string(),
    }
}

fn ask(tool: &str) -> clauro_core::PermissionRule {
    clauro_core::PermissionRule {
        effect: clauro_core::Effect::Ask,
        tool: tool.to_string(),
    }
}

fn bind_counting(reg: &mut clauro_tools::Registry, name: &str, count: Arc<Mutex<usize>>) {
    let name = name.to_string();
    reg.set_handler(name.as_str(), move |_, _| {
        *count.lock().expect("lock") += 1;
        clauro_core::ToolOutcome::Ok {
            preview: "did it".to_string(),
            preview_path: None,
            full_path: None,
        }
    })
    .expect("bind");
}

// ── permissions at dispatch ──────────────────────────────────────────────────

#[test]
fn denied_tool_never_dispatches_and_gets_typed_error() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&["fs"], vec![deny("fs")]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();
    let count = Arc::new(Mutex::new(0usize));
    bind_counting(&mut reg, "fs", count.clone());
    let mut exchange = Script {
        steps: VecDeque::from([
            tool_step("c1", "fs", r#"{"command":"list","path":"."}"#),
            text_step("fine, moving on"),
        ]),
        bodies: vec![],
    };
    let mut turn_loop = TurnLoop::new();
    let report = turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut exchange,
            TurnPlan {
                thread_id: "t1",
                user_text: "list it",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
        )
        .expect("turn runs");
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
    assert_eq!(
        *count.lock().expect("lock"),
        0,
        "denied never reaches the handler"
    );
    let results = t.main.tool_results_for_thread("t1");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, clauro_core::ToolStatus::Error);
}

// ── ask holds, approve resumes ───────────────────────────────────────────────

#[test]
fn ask_holds_then_dispatches_after_approve() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&["bash"], vec![ask("bash")]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();
    let count = Arc::new(Mutex::new(0usize));
    bind_counting(&mut reg, "bash", count.clone());
    let mut turn_loop = TurnLoop::new();

    let mut first = Script {
        steps: VecDeque::from([tool_step("h1", "bash", r#"{"command":"run"}"#)]),
        bodies: vec![],
    };
    let report = turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut first,
            TurnPlan {
                thread_id: "t1",
                user_text: "run it",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
        )
        .expect("turn runs");
    assert_eq!(report.end, TurnEnd::AwaitingApproval, "{report:?}");
    assert_eq!(
        report.pending_approvals,
        vec!["h1".to_string()],
        "{report:?}"
    );
    assert_eq!(*count.lock().expect("lock"), 0, "held, not dispatched");
    assert_eq!(
        t.main.tool_results_for_thread("t1").len(),
        0,
        "no result yet"
    );

    turn_loop.approve_call("t1", "h1").expect("approve");
    let mut second = Script {
        steps: VecDeque::from([text_step("thanks")]),
        bodies: vec![],
    };
    let report = turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut second,
            TurnPlan {
                thread_id: "t1",
                user_text: "go on",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
        )
        .expect("turn runs");
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
    assert_eq!(*count.lock().expect("lock"), 1, "approved call dispatched");
    let results = t.main.tool_results_for_thread("t1");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, clauro_core::ToolStatus::Ok);
    let pairing = clauro_store::transcript::find_unpaired_tool_uses(
        &t.main.blocks_for_thread("t1"),
        &results,
    );
    assert!(pairing.unpaired.is_empty(), "{pairing:?}");
}

// ── question gate at the loop ────────────────────────────────────────────────

#[test]
fn mixed_question_call_refused_others_dispatch() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&["question", "fs"], vec![]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();
    let mut turn_loop = TurnLoop::new();
    let gate = turn_loop.question_gate("t1");
    register_question_with_gate(&mut reg, gate);
    let count = Arc::new(Mutex::new(0usize));
    bind_counting(&mut reg, "fs", count.clone());
    let mut exchange = Script {
        steps: VecDeque::from([
            [
                tool_step(
                    "q1",
                    "question",
                    r#"{"id":"q1","prompt":"Pick?","options":[],"allowFreeText":true}"#,
                ),
                tool_step("c1", "fs", r#"{"command":"list","path":"."}"#),
            ]
            .concat(),
            text_step("ok"),
        ]),
        bodies: vec![],
    };
    let report = turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut exchange,
            TurnPlan {
                thread_id: "t1",
                user_text: "both",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
        )
        .expect("turn runs");
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
    assert_eq!(*count.lock().expect("lock"), 1, "fs dispatched");
    let results = t.main.tool_results_for_thread("t1");
    assert_eq!(results.len(), 2);
    let refused = results
        .iter()
        .find(|r| r.tool_call_id == "q1")
        .expect("question row");
    assert_eq!(refused.status, clauro_core::ToolStatus::Error);
}

// ── bounding at the loop ─────────────────────────────────────────────────────

#[test]
fn big_previews_store_paths_and_stay_bounded() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&["fs"], vec![]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();
    reg.set_handler("fs", |_, _| clauro_core::ToolOutcome::Ok {
        preview: "z".repeat(20_000),
        preview_path: None,
        full_path: None,
    })
    .expect("bind");
    let mut exchange = Script {
        steps: VecDeque::from([
            tool_step("c1", "fs", r#"{"command":"list","path":"."}"#),
            text_step("done"),
        ]),
        bodies: vec![],
    };
    let mut turn_loop = TurnLoop::new();
    turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut exchange,
            TurnPlan {
                thread_id: "t1",
                user_text: "big",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
        )
        .expect("turn runs");
    let full = t
        .main
        .get_tool_result_full("t1", "c1")
        .expect("row must exist");
    assert!(
        full.preview_path.is_some() && full.full_path.is_some(),
        "{full:?}"
    );
    assert!(
        full.preview.len() <= 8 * 1024 + 64,
        "bounded: {}",
        full.preview.len()
    );
    let stored = std::fs::read_to_string(full.full_path.expect("path")).expect("full reads");
    assert_eq!(stored.len(), 20_000, "nothing lost");
}

// ── compact never in schema ──────────────────────────────────────────────────

#[test]
fn compact_absent_from_request_schema() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&["memory", "fs", "question", "compact"], vec![]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();
    bind_counting(&mut reg, "fs", Arc::new(Mutex::new(0)));
    let mut exchange = Script {
        steps: VecDeque::from([text_step("hi")]),
        bodies: vec![],
    };
    let mut turn_loop = TurnLoop::new();
    turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut exchange,
            TurnPlan {
                thread_id: "t1",
                user_text: "hi",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
        )
        .expect("turn runs");
    for body in &exchange.bodies {
        let names: Vec<&str> = body["tools"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            !names.contains(&"compact"),
            "host-driven only (D14): {names:?}"
        );
    }
    assert!(!exchange.bodies.is_empty());
}
