//! Phase-2 wiring: the loop enforces what the components prove (RED).
//!
//! `resolve()` gates every dispatch (deny → typed error, never dispatched);
//! `ask` holds into `ApprovalQueue` and resumes on a later turn; the
//! question gate sees every call with per-message reset; `Ok` previews are
//! bounded on the way out with stored paths; `compact` never reaches the
//! request schema.

use clauro_loop::prompt::first_turn_setup;
use clauro_loop::run::{
    Exchange, ExchangeFailure, LoopError, PreparedThread, TurnEnd, TurnLoop, TurnPlan,
};
use clauro_store::{NewBlock, NewThread, Store};
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
    // Fresh by construction (see e2e_phase2): never reuse an existing dir.
    let mut stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = loop {
        let candidate =
            std::env::temp_dir().join(format!("clauro-wiring-{}-{n}-{stamp}", std::process::id()));
        if std::fs::create_dir(&candidate).is_ok() {
            break candidate;
        }
        stamp += 1;
    };
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
    fn step(
        &mut self,
        request: &BuiltRequest,
        sink: &mut dyn FnMut(NormalisedEvent),
    ) -> Result<Vec<NormalisedEvent>, ExchangeFailure> {
        self.bodies.push(request.body.clone());
        let events = self.steps.pop_front().expect("script exhausted");
        for event in &events {
            sink(event.clone());
        }
        Ok(events)
    }
}

fn tool_step(id: &str, name: &str, input: &str) -> Vec<NormalisedEvent> {
    tool_step_at(0, id, name, input)
}

/// A tool call at an explicit block index, so one assistant message can carry
/// several closed calls (the message-shaped case the pairing tests need).
fn tool_step_at(index: u32, id: &str, name: &str, input: &str) -> Vec<NormalisedEvent> {
    vec![
        NormalisedEvent::BlockStart {
            index,
            kind: InboundKind::ToolUse,
            tool: Some(ToolHeader {
                id: id.to_string(),
                name: name.to_string(),
            }),
        },
        NormalisedEvent::BlockDelta {
            index,
            text: Some(input.to_string()),
            signature: None,
        },
        NormalisedEvent::BlockStop { index },
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
            thinking_budget: 512,
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
            &mut |_| {},
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

/// D26 critical: a denied tool is removed from the request, not filtered from
/// the results. The tool must not ship in the body at all — the results-side
/// arm above only defends once the model has already been told the tool exists.
#[test]
fn denied_tool_absent_from_the_request_body() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&["fs", "memory"], vec![deny("fs")]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();
    bind_counting(&mut reg, "fs", Arc::new(Mutex::new(0)));

    let mut exchange = Script {
        steps: VecDeque::from([text_step("hi")]),
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
                user_text: "hi",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
            &mut |_| {},
        )
        .expect("the turn runs");

    assert!(
        !exchange.bodies.is_empty(),
        "the request body must have been recorded: {report:?}"
    );
    for body in &exchange.bodies {
        let names: Vec<&str> = body["tools"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|tv| tv.get("name").and_then(|n| n.as_str()))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            !names.contains(&"fs"),
            "a denied tool must never ship in the request body (D26): {names:?}"
        );
        assert!(
            names.contains(&"memory"),
            "the rest of the granted surface still ships: {names:?}"
        );
    }
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
            &mut |_| {},
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
            &mut |_| {},
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

/// NIT run.rs:420 — a rejection must name the tool it rejected. The verdict
/// reads the name from the transcript's own `tool_use` block: a result row
/// with no tool is unattributable, and a missing block fails typed rather
/// than writing an empty name.
#[test]
fn rejection_lookup_names_the_tool_from_the_transcript() {
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
    turn_loop
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
            &mut |_| {},
        )
        .expect("turn holds");

    let blocks = t.main.blocks_for_thread("t1");
    assert_eq!(
        clauro_loop::run::tool_name_of_call(&blocks, "h1").as_deref(),
        Some("bash"),
        "the transcript knows which tool the held call is"
    );
    assert_eq!(
        clauro_loop::run::tool_name_of_call(&blocks, "missing"),
        None,
        "an unknown call has no name to report"
    );

    // The rejection path consumes exactly that lookup — it succeeds only if
    // the name is available, never a nameless verdict.
    turn_loop.reject_call(&t.main, "t1", "h1").expect("reject");
    let results = t.main.tool_results_for_thread("t1");
    assert_eq!(results.len(), 1, "{results:?}");
    assert_eq!(results[0].status, clauro_core::ToolStatus::Rejected);
    assert_eq!(*count.lock().expect("lock"), 0, "never dispatched");
}

/// Ask-hold critical: when one message carries an ask call plus siblings, the
/// siblings close as aborted the way a stop closes them. An open tool_use with
/// no result makes every later request a provider 400 — after approval the
/// thread must pair completely.
#[test]
fn ask_hold_closes_sibling_calls_and_the_thread_stays_pairable() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&["bash", "fs"], vec![ask("bash")]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();
    let bash_count = Arc::new(Mutex::new(0usize));
    let fs_count = Arc::new(Mutex::new(0usize));
    bind_counting(&mut reg, "bash", bash_count.clone());
    bind_counting(&mut reg, "fs", fs_count.clone());
    let mut turn_loop = TurnLoop::new();

    // One assistant message, two closed calls: the ask call first (index 0),
    // an allowed sibling after it (index 1).
    let mut first = Script {
        steps: VecDeque::from([[
            tool_step_at(0, "h1", "bash", r#"{"command":"run"}"#),
            tool_step_at(1, "s1", "fs", r#"{"command":"list","path":"."}"#),
        ]
        .concat()]),
        bodies: vec![],
    };
    let report = turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut first,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
            &mut |_| {},
        )
        .expect("turn runs");
    assert_eq!(report.end, TurnEnd::AwaitingApproval, "{report:?}");
    assert_eq!(
        report.pending_approvals,
        vec!["h1".to_string()],
        "{report:?}"
    );
    assert_eq!(*bash_count.lock().expect("lock"), 0, "held, not run");
    assert_eq!(
        *fs_count.lock().expect("lock"),
        0,
        "the sibling is closed, not dispatched"
    );

    // The sibling closed as aborted; the held call alone stays open.
    let results = t.main.tool_results_for_thread("t1");
    let sibling = results
        .iter()
        .find(|r| r.tool_call_id == "s1")
        .expect("the sibling has a result row");
    assert_eq!(
        sibling.status,
        clauro_core::ToolStatus::Aborted,
        "{results:?}"
    );
    assert!(
        results.iter().all(|r| r.tool_call_id != "h1"),
        "the held call has no result yet: {results:?}"
    );
    let pairing = clauro_store::transcript::find_unpaired_tool_uses(
        &t.main.blocks_for_thread("t1"),
        &results,
    );
    assert_eq!(
        pairing.unpaired,
        vec!["h1".to_string()],
        "only the held call awaits approval: {pairing:?}"
    );

    // Approval dispatches the held call; the next request pairs completely.
    turn_loop.approve_call("t1", "h1").expect("approve");
    let mut second = Script {
        steps: VecDeque::from([text_step("done")]),
        bodies: vec![],
    };
    let report = turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut second,
            TurnPlan {
                thread_id: "t1",
                user_text: "continue",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
            &mut |_| {},
        )
        .expect("second turn");
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
    assert_eq!(*bash_count.lock().expect("lock"), 1, "approved ran");
    let results = t.main.tool_results_for_thread("t1");
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
            &mut |_| {},
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
            &mut |_| {},
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

// ── openai unknown events surface visibly ──────────────────────────────────

#[test]
fn ignored_events_become_visible_notices() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&[], vec![]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();
    let mut first = text_step("ok");
    first.insert(
        0,
        NormalisedEvent::Ignored {
            raw_type: "response.reasoning_summary_text.delta".to_string(),
        },
    );
    let mut exchange = Script {
        steps: VecDeque::from([first]),
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
                user_text: "hi",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
            &mut |_| {},
        )
        .expect("turn runs");
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
    let notices: Vec<_> = t
        .main
        .blocks_for_thread("t1")
        .into_iter()
        .filter(|b| b.kind == "notice")
        .collect();
    assert_eq!(notices.len(), 1, "one visible notice, not a silent drop");
    assert!(
        notices[0]
            .payload
            .contains("response.reasoning_summary_text.delta"),
        "notice names the unrendered event: {}",
        notices[0].payload
    );
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
            &mut |_| {},
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

// ── cancellation reaches the exchange ────────────────────────────────────────

/// The loop hands the exchange the thread's stop handle before the first
/// step, so a long stream can be cancelled mid-read instead of only between
/// steps. The loop's half is this plumbing; `LiveExchange` checks the flag per
/// read/retry on the host side.
#[test]
fn exchange_receives_the_thread_stop_flag() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&["fs"], vec![]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();

    struct Watcher {
        flag: Option<Arc<std::sync::atomic::AtomicBool>>,
        steps: VecDeque<Vec<NormalisedEvent>>,
    }
    impl Exchange for Watcher {
        fn set_stop_flag(&mut self, flag: Arc<std::sync::atomic::AtomicBool>) {
            self.flag = Some(flag);
        }
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

    let mut watcher = Watcher {
        flag: None,
        steps: VecDeque::from([text_step("hi")]),
    };
    let mut turn_loop = TurnLoop::new();
    turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut watcher,
            TurnPlan {
                thread_id: "t1",
                user_text: "hi",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
            &mut |_| {},
        )
        .expect("turn runs");

    let flag = watcher
        .flag
        .expect("the exchange received the thread stop flag");
    assert!(
        !flag.load(std::sync::atomic::Ordering::SeqCst),
        "a fresh turn is not stopped"
    );
    turn_loop.stop("t1");
    assert!(
        flag.load(std::sync::atomic::Ordering::SeqCst),
        "the exchange holds the very flag a stop flips"
    );
}

/// A stop observed MID-STEP (the host's per-read check halts the stream and
/// returns the events sunk so far — review 21's cancellation finding) ends
/// the turn as `Stopped`, the same label a between-steps stop gets: the
/// stop/continue offer must not depend on where in the stream the flag
/// flipped.
#[test]
fn a_stop_during_the_stream_ends_the_turn_stopped() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&["fs"], vec![]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();

    struct StopDuringStep {
        flag: Option<Arc<std::sync::atomic::AtomicBool>>,
        steps: VecDeque<Vec<NormalisedEvent>>,
    }
    impl Exchange for StopDuringStep {
        fn set_stop_flag(&mut self, flag: Arc<std::sync::atomic::AtomicBool>) {
            self.flag = Some(flag);
        }
        fn step(
            &mut self,
            _request: &BuiltRequest,
            sink: &mut dyn FnMut(NormalisedEvent),
        ) -> Result<Vec<NormalisedEvent>, ExchangeFailure> {
            let events = self.steps.pop_front().expect("script exhausted");
            for event in &events {
                sink(event.clone());
            }
            // The user presses stop while the stream is mid-read: the host
            // halts the read and returns Ok with what it already sank.
            if let Some(flag) = &self.flag {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(events)
        }
    }

    let mut exchange = StopDuringStep {
        flag: None,
        steps: VecDeque::from([text_step("partial answer")]),
    };
    let mut turn_loop = TurnLoop::new();
    let report = turn_loop
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
            &mut |_| {},
        )
        .expect("turn runs");

    assert_eq!(
        report.end,
        TurnEnd::Stopped,
        "a mid-stream stop is a stop, not a completed turn"
    );
}

// ── storage faults are typed, never re-labelled ──────────────────────────────

/// A storage fault while writing the question card fails the turn typed; it
/// is never rewritten into a model refusal (a refusal row would blame the
/// model for the host's disk). The card insert is the only write inside the
/// fault window: the tool_use block already sits in the transcript.
#[test]
fn store_fault_writing_the_card_never_becomes_a_model_refusal() {
    let t = trees();
    let (prepared, frozen) = prepared_with(&["question"], vec![]);
    seed_thread(&t.main, &frozen);
    let mut reg = clauro_tools::Registry::with_eight();

    // Second handle to the same DB, captured by the handler: it writes a
    // generation-1 block inside the dispatch, so the card's generation-0
    // insert afterwards is refused with `GenerationRegression`.
    let shared = Arc::new(Mutex::new(
        Store::open(&t.tmp.join("test.db")).expect("second handle"),
    ));
    reg.set_handler("question", move |_input, _ctx| {
        let store = shared.lock().expect("lock");
        let blocks = store.blocks_for_thread("t1");
        let first = blocks.first().expect("seeded user block");
        let msg_id = store.message_id_for_block(&first.id).expect("message id");
        let seq = store
            .blocks_for_message(&msg_id)
            .iter()
            .map(|b| b.seq)
            .max()
            .unwrap_or(0)
            + 500;
        store
            .insert_block(NewBlock {
                id: Store::new_id("b"),
                message_id: msg_id,
                seq,
                kind: "notice".to_string(),
                payload: serde_json::json!({"text": "injected fault"}).to_string(),
                boundary: None,
                is_summary: false,
                generation: 1,
                signature: None,
                dropped: false,
            })
            .expect("injected generation-1 block");
        clauro_core::ToolOutcome::Ok {
            preview: "ask".to_string(),
            preview_path: None,
            full_path: None,
        }
    })
    .expect("bind");

    let mut exchange = Script {
        steps: VecDeque::from([tool_step(
            "q1",
            "question",
            r#"{"id":"q1","prompt":"Pick?","options":[],"allowFreeText":true}"#,
        )]),
        bodies: vec![],
    };
    let mut turn_loop = TurnLoop::new();
    let err = turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut exchange,
            TurnPlan {
                thread_id: "t1",
                user_text: "ask me",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
            &mut |_| {},
        )
        .expect_err("a storage fault must fail the turn typed");
    assert!(
        matches!(err, LoopError::Store(_)),
        "typed store error, got: {err:?}"
    );
    let results = t.main.tool_results_for_thread("t1");
    assert!(
        results.is_empty(),
        "the fault must not be re-labelled as a model refusal: {results:?}"
    );
}
