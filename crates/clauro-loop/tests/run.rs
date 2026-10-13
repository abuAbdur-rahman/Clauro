//! Task 023 — the serial turn loop (RED).
//!
//! Two `tool_use` blocks run to `end_turn`, in order, one at a time. Stop
//! closes every dispatched call (D65) and keeps completed work (D68).
//! Throwing handlers and transport failures become transcript rows, never
//! hung turns or escapes (D55). Prompt hash frozen per thread (D19).

use clauro_core::ToolOutcome;
use clauro_loop::prompt::first_turn_setup;
use clauro_loop::queue::StopOffer;
use clauro_loop::run::{
    Exchange, ExchangeFailure, LoopError, PreparedThread, TurnEnd, TurnLoop, TurnPlan,
};
use clauro_store::{NewProject, NewThread, Store};
use clauro_tools::Registry;
use clauro_transport::{BuiltRequest, InboundKind, NormalisedEvent, ToolHeader, UsageWire};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

static SEQ: AtomicU64 = AtomicU64::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn fresh() -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("clauro-023-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).expect("scratch");
        Self { path }
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Scripted provider: canned steps, records request bodies.
struct Script {
    steps: VecDeque<Result<Vec<NormalisedEvent>, String>>,
    pub bodies: Vec<serde_json::Value>,
}

impl Script {
    fn new(steps: Vec<Vec<NormalisedEvent>>) -> Self {
        Self {
            steps: steps.into_iter().map(Ok).collect(),
            bodies: Vec::new(),
        }
    }

    fn failing_after(first: Vec<NormalisedEvent>, msg: &str) -> Self {
        let mut steps = VecDeque::new();
        steps.push_back(Ok(first));
        steps.push_back(Err(msg.to_string()));
        Self {
            steps,
            bodies: Vec::new(),
        }
    }
}

impl Exchange for Script {
    fn step(
        &mut self,
        request: &BuiltRequest,
        sink: &mut dyn FnMut(NormalisedEvent),
    ) -> Result<Vec<NormalisedEvent>, ExchangeFailure> {
        self.bodies.push(request.body.clone());
        let events = self
            .steps
            .pop_front()
            .expect("script exhausted")
            .map_err(|message| ExchangeFailure { message })?;
        // Sink what we return: the trait contract is that every returned
        // event reaches the sink, in order.
        for event in &events {
            sink(event.clone());
        }
        Ok(events)
    }
}

fn tool_use_step(calls: &[(&str, &str, &str)]) -> Vec<NormalisedEvent> {
    // One assistant message carrying N tool_use blocks, fully closed.
    let mut events = Vec::new();
    for (i, (id, name, input)) in calls.iter().enumerate() {
        let index = i as u32;
        events.push(NormalisedEvent::BlockStart {
            index,
            kind: InboundKind::ToolUse,
            tool: Some(ToolHeader {
                id: id.to_string(),
                name: name.to_string(),
            }),
        });
        events.push(NormalisedEvent::BlockDelta {
            index,
            text: Some(input.to_string()),
            signature: None,
        });
        events.push(NormalisedEvent::BlockStop { index });
    }
    events
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

fn seeded(dir: &TestDir, thread_id: &str, frozen: &str) -> Store {
    let store = Store::open(&dir.path.join("test.db")).expect("open");
    store
        .insert_project(NewProject {
            id: "p1".to_string(),
            name: "proj".to_string(),
            instructions: String::new(),
            bash_enabled: false,
        })
        .expect("project");
    store
        .insert_thread(NewThread {
            id: thread_id.to_string(),
            project_id: Some("p1".to_string()),
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: frozen.to_string(),
            tools_frozen: "[]".to_string(),
        })
        .expect("thread");
    store
}

fn prepared(thread_tools: Vec<clauro_tools::MaterializedTool>) -> PreparedThread {
    let defs = clauro_tools::eight_definitions();
    let (system_text, frozen_hash) = first_turn_setup(&defs, None);
    PreparedThread {
        system_text,
        frozen_hash,
        model: "claude-x".to_string(),
        max_tokens: 1024,
        tools: thread_tools,
        thinking_budget: 512,
        rules: Vec::new(),
    }
}

fn available_tools() -> Vec<clauro_tools::MaterializedTool> {
    use clauro_tools::{materialize, ThreadToolState};
    let mut granted = ThreadToolState::default();
    for t in [
        "memory",
        "artifact",
        "web-search",
        "web-fetch",
        "fs",
        "question",
    ] {
        granted.granted.insert(t.to_string());
    }
    let avail = materialize(None, &granted);
    avail.anthropic_tools
}

fn bind_echo(reg: &mut Registry, order: Arc<std::sync::Mutex<Vec<String>>>) {
    for name in ["fs", "memory"] {
        let order = order.clone();
        reg.set_handler(name, move |input, _| {
            order.lock().expect("order").push(name.to_string());
            ToolOutcome::Ok {
                preview: format!("did:{input}"),
                preview_path: None,
                full_path: None,
            }
        })
        .expect("bind");
    }
}

// ── the loop ─────────────────────────────────────────────────────────────────

/// A blockless assistant message (usage-only step, storage blip, empty reply)
/// must not brick the thread: the next turn's rows land on fresh seqs instead
/// of colliding with `idx_message_seq` on every turn from then on.
#[test]
fn blockless_assistant_message_does_not_brick_the_next_turn() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();

    // Turn 1: the provider returns a usage-only step — an assistant message
    // with no blocks at all.
    let mut ex1 = Script::new(vec![vec![NormalisedEvent::Usage {
        usage: UsageWire {
            top_input_tokens: 10,
            top_output_tokens: 5,
            iterations: Vec::new(),
            billing_input_tokens: 10,
            billing_output_tokens: 5,
            context_input_tokens: 10,
        },
    }]]);
    let mut turn_loop = TurnLoop::new();
    let report = turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex1,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn one runs");
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
    assert_eq!(report.assistant_messages, 1, "{report:?}");

    // Turn 2 must run: its rows reuse no seq, even though the blockless
    // message already holds one the blocks-only scan cannot see.
    let mut ex2 = Script::new(vec![text_step("second answer")]);
    let report = turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex2,
            TurnPlan {
                thread_id: "t1",
                user_text: "again",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn two must run after a blockless message");
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
    assert_eq!(role_texts(&store, "user"), vec!["go", "again"]);
    assert_eq!(role_texts(&store, "assistant"), vec!["second answer"]);
}

#[test]
fn two_tool_uses_run_to_end_turn_in_order() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    bind_echo(&mut reg, order.clone());
    let mut ex = Script::new(vec![
        tool_use_step(&[
            ("call-a", "fs", "{\"p\":\"a\"}"),
            ("call-b", "memory", "{}"),
        ]),
        text_step("done"),
    ]);
    let mut turn_loop = TurnLoop::new();
    let report = turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn runs");
    assert_eq!(report.end, TurnEnd::EndTurn);
    assert_eq!(
        report.dispatched,
        vec!["call-a".to_string(), "call-b".to_string()]
    );
    assert_eq!(
        *order.lock().expect("order"),
        vec!["fs".to_string(), "memory".to_string()]
    );
    assert_eq!(ex.bodies.len(), 2, "re-send happened after tools");
}

#[test]
fn second_result_lands_after_first_serially() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    bind_echo(&mut reg, order.clone());
    let mut ex = Script::new(vec![
        tool_use_step(&[("call-1", "fs", "{}"), ("call-2", "fs", "{}")]),
        text_step("ok"),
    ]);
    let mut turn_loop = TurnLoop::new();
    turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn");
    let results = store.tool_results_for_thread("t1");
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].tool_call_id, "call-1");
    assert_eq!(results[1].tool_call_id, "call-2");
    // I1 holds on the loop-written transcript.
    let blocks = store.blocks_for_thread("t1");
    let res = store.tool_results_for_thread("t1");
    let report = clauro_store::transcript::find_unpaired_tool_uses(&blocks, &res);
    assert!(report.unpaired.is_empty(), "{report:?}");
}

#[test]
fn stop_mid_loop_closes_everything_and_keeps_work() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let mut turn_loop = TurnLoop::new();
    let flag = turn_loop.stop_flag("t1");
    reg.set_handler("fs", move |_, _| {
        flag.store(true, Ordering::SeqCst); // user stops during first dispatch
        ToolOutcome::Ok {
            preview: "partial".to_string(),
            preview_path: None,
            full_path: None,
        }
    })
    .expect("bind");
    reg.set_handler("memory", |_, _| ToolOutcome::Ok {
        preview: "never".to_string(),
        preview_path: None,
        full_path: None,
    })
    .expect("bind");
    let mut ex = Script::new(vec![tool_use_step(&[
        ("call-a", "fs", "{}"),
        ("call-b", "memory", "{}"),
    ])]);
    let report = turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn");
    assert_eq!(report.end, TurnEnd::Stopped);
    let results = store.tool_results_for_thread("t1");
    let statuses: Vec<String> = results
        .iter()
        .map(|r| format!("{}:{:?}", r.tool_call_id, r.status))
        .collect();
    assert!(
        statuses.iter().any(|s| s.starts_with("call-a:Ok")),
        "{statuses:?}"
    );
    assert!(
        statuses.iter().any(|s| s.starts_with("call-b:Aborted")),
        "{statuses:?}"
    );
    let blocks = store.blocks_for_thread("t1");
    assert!(!blocks.is_empty(), "completed work retained (D68)");
    let res = store.tool_results_for_thread("t1");
    let pairing = clauro_store::transcript::find_unpaired_tool_uses(&blocks, &res);
    assert!(
        pairing.unpaired.is_empty(),
        "zero orphans (D65): {pairing:?}"
    );
}

#[test]
fn throwing_handler_becomes_error_row_and_loop_continues() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    reg.set_handler("fs", |_, _| panic!("handler bug"))
        .expect("bind");
    let mut ex = Script::new(vec![
        tool_use_step(&[("call-x", "fs", "{}")]),
        text_step("recovered"),
    ]);
    let mut turn_loop = TurnLoop::new();
    let report = turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn");
    assert_eq!(
        report.end,
        TurnEnd::EndTurn,
        "loop continues past the throw (D55)"
    );
    let results = store.tool_results_for_thread("t1");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, clauro_core::ToolStatus::Error);
}

#[test]
fn transport_failure_is_a_transcript_row_not_a_hang() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let mut ex =
        Script::failing_after(tool_use_step(&[("call-a", "fs", "{}")]), "connection reset");
    reg.set_handler("fs", |_, _| ToolOutcome::Ok {
        preview: "p".to_string(),
        preview_path: None,
        full_path: None,
    })
    .expect("bind");
    let mut turn_loop = TurnLoop::new();
    let report = turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn returns, never hangs");
    assert_eq!(report.end, TurnEnd::TransportError);
    let blocks = store.blocks_for_thread("t1");
    assert!(
        blocks.iter().any(|b| b.kind == "notice"),
        "typed error lands in the transcript: {:?}",
        blocks.iter().map(|b| &b.kind).collect::<Vec<_>>()
    );
}

#[test]
fn prefix_change_is_detected_not_absorbed() {
    let dir = TestDir::fresh();
    let store = seeded(&dir, "t1", "stale-hash");
    let mut reg = Registry::with_eight();
    let mut ex = Script::new(vec![text_step("hi")]);
    let mut turn_loop = TurnLoop::new();
    let err = turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect_err("changed prefix must fail, not silently run");
    assert!(matches!(err, LoopError::PrefixChanged { .. }), "{err:?}");
}

/// Audit 12 (lead-routed): Anthropic hard-400s `thinking.budget_tokens >=
/// max_tokens`. The pair is rejected client-side as a typed loop error before
/// any request exists — never sent, never surfaced as a raw provider 400.
#[test]
fn overlong_thinking_budget_is_rejected_before_any_request() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let mut ex = Script::new(vec![text_step("never sent")]);
    let mut overlong = prepared(available_tools());
    overlong.thinking_budget = overlong.max_tokens; // equal is already a 400
    let mut turn_loop = TurnLoop::new();
    let err = turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &overlong,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect_err("budget >= max must fail client-side, not at the provider");
    assert!(
        matches!(
            err,
            LoopError::BudgetNotBelowMax {
                budget_tokens,
                max_tokens,
            } if budget_tokens == overlong.thinking_budget && max_tokens == overlong.max_tokens
        ),
        "{err:?}"
    );
}

/// NIT run.rs:297 — D27's failure path: when the bounding write fails, the
/// raw preview must not ship inline at full scale — the row would be re-sent
/// on every later step. The cap is the documented preview limit.
#[test]
fn bounding_failure_caps_the_inline_preview() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let huge = "x".repeat(clauro_tools::PREVIEW_LIMIT_CHARS * 3);
    reg.set_handler("fs", move |_, _| ToolOutcome::Ok {
        preview: huge.clone(),
        preview_path: None,
        full_path: None,
    })
    .expect("bind");
    let mut ex = Script::new(vec![
        tool_use_step(&[("call-a", "fs", "{}")]),
        text_step("done"),
    ]);
    let mut turn_loop = TurnLoop::new();
    turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                // No such directory: bound_output's write fails here.
                workspace_dir: &dir.path.join("never-created"),
            },
            &mut |_| {},
        )
        .expect("turn runs");
    let full = store
        .get_tool_result_full("t1", "call-a")
        .expect("result row");
    assert!(
        full.preview.chars().count() <= clauro_tools::PREVIEW_LIMIT_CHARS,
        "bounding failure must still cap the inline preview: {} chars",
        full.preview.chars().count()
    );
}

/// NIT run.rs:215 — thread-scoped maps must not outlive their thread:
/// removal releases every map, and `tracked` reports the truth.
#[test]
fn remove_thread_releases_every_scoped_map() {
    let mut turn_loop = TurnLoop::new();
    let _ = turn_loop.stop_flag("t1");
    let queued = turn_loop.send_while_busy("t1", "queued text");
    assert!(!queued.is_empty());
    assert!(turn_loop.tracked("t1"), "the maps hold the thread");
    turn_loop.remove_thread("t1");
    assert!(!turn_loop.tracked("t1"), "the maps released the thread");
}

#[test]
fn resent_requests_carry_prior_tool_results() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    reg.set_handler("fs", |_, _| ToolOutcome::Ok {
        preview: "file!".to_string(),
        preview_path: None,
        full_path: None,
    })
    .expect("bind");
    let mut ex = Script::new(vec![
        tool_use_step(&[("call-a", "fs", "{}")]),
        text_step("ok"),
    ]);
    let mut turn_loop = TurnLoop::new();
    turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn");
    assert_eq!(ex.bodies.len(), 2);
    let second = ex.bodies[1].to_string();
    assert!(
        second.contains("call-a"),
        "re-send carries the pair: {second}"
    );
    assert!(second.contains("file!"), "{second}");
}

/// The wire shape both adapters require, proven on the stored transcript.
///
/// The Anthropic Messages API takes a `tool_result` back **in a subsequent
/// user message** — never inside the assistant message that made the call
/// (platform.claude.com/docs/en/api/messages: tool results "return ... in a
/// subsequent `user` message"). The OpenAI-compatible adapter needs the same
/// separation to map onto `role: "tool"`. `assemble_messages` groups blocks by
/// their stored message, and results persist into the assistant message that
/// held the `tool_use`, so the split has to happen at assembly time.
#[test]
fn tool_results_ride_the_next_user_message_not_the_assistant() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    reg.set_handler("fs", |_, _| ToolOutcome::Ok {
        preview: "file!".to_string(),
        preview_path: None,
        full_path: None,
    })
    .expect("bind");
    let mut ex = Script::new(vec![
        tool_use_step(&[("call-a", "fs", "{}")]),
        text_step("ok"),
    ]);
    let mut turn_loop = TurnLoop::new();
    turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn");
    let messages = ex.bodies[1]["messages"]
        .as_array()
        .expect("messages array")
        .clone();

    // 1. No assistant message ever carries a tool_result block.
    for (i, m) in messages.iter().enumerate() {
        if m["role"] != "assistant" {
            continue;
        }
        if let Some(blocks) = m["content"].as_array() {
            for block in blocks {
                assert_ne!(
                    block["type"], "tool_result",
                    "tool_result inside assistant message {i}: {messages:?}"
                );
            }
        }
    }

    // 2. The result rides a user message that directly follows its tool_use.
    let use_at = messages
        .iter()
        .position(|m| {
            m["role"] == "assistant"
                && m["content"]
                    .as_array()
                    .map(|blocks| {
                        blocks
                            .iter()
                            .any(|b| b["type"] == "tool_use" && b["id"] == "call-a")
                    })
                    .unwrap_or(false)
        })
        .expect("assistant message holds call-a");
    let next = messages
        .get(use_at + 1)
        .expect("a message follows the tool_use");
    assert_eq!(
        next["role"], "user",
        "tool results must ride the next user message: {messages:?}"
    );
    let carried = next["content"]
        .as_array()
        .map(|blocks| {
            blocks.iter().any(|b| {
                b["type"] == "tool_result"
                    && b["tool_use_id"] == "call-a"
                    && b["content"] == "file!"
            })
        })
        .unwrap_or(false);
    assert!(
        carried,
        "user message after call-a carries its result: {messages:?}"
    );
}

// ── queue through the loop ───────────────────────────────────────────────────

#[test]
fn mid_turn_message_queues_then_dispatches_when_idle() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let mut ex = Script::new(vec![text_step("one"), text_step("two")]);
    let mut turn_loop = TurnLoop::new();
    turn_loop.send_while_busy("t1", "queued follow-up");
    let prep = prepared(available_tools());
    turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "first",
                prepared: &prep,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn one");
    let item = turn_loop.drain_next("t1").expect("drains when idle");
    assert_eq!(item.text, "queued follow-up");
    turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: &item.text,
                prepared: &prep,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn two");
    let users = store
        .blocks_for_thread("t1")
        .into_iter()
        .filter(|b| b.kind == "text")
        .count();
    assert!(users >= 2, "two turns, never merged");
}

#[test]
fn stop_with_queue_offers_drain_or_discard() {
    let mut turn_loop = TurnLoop::new();
    assert!(turn_loop.stop("t1").is_none());
    turn_loop.send_while_busy("t1", "waiting");
    assert_eq!(turn_loop.stop("t1"), Some(StopOffer::DrainOrDiscard));
    assert_eq!(turn_loop.discard_unsent("t1"), 1);
    assert!(turn_loop.stop("t1").is_none());
}

#[test]
fn send_now_extracts_without_draining() {
    let mut turn_loop = TurnLoop::new();
    let id_later = turn_loop.send_while_busy("t1", "later");
    let id_now = turn_loop.send_while_busy("t1", "now");
    assert!(turn_loop.send_now("t1", "bogus").is_none());
    let item = turn_loop.send_now("t1", &id_now).expect("chip id");
    assert_eq!(item.id, id_now);
    assert_eq!(item.text, "now");
    // The sibling stays queued: send-now never drains.
    let rest = turn_loop.drain_next("t1").expect("sibling still queued");
    assert_eq!(rest.id, id_later);
}

/// A stop that lands before the turn begins still halts it: the flag is the
/// driver's to clear (once, at claim), never the loop's to wipe at entry —
/// otherwise a stop arriving during turn preparation is discarded unseen.
#[test]
fn stop_set_before_run_turn_halts_the_turn() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let mut ex = Script::new(vec![text_step("never sent")]);
    let mut turn_loop = TurnLoop::new();

    turn_loop.stop("t1");
    let report = turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn runs");
    assert_eq!(report.end, TurnEnd::Stopped, "{report:?}");
    assert!(
        ex.bodies.is_empty(),
        "no request may leave the process after a stop: {:?}",
        ex.bodies
    );

    // The driver clears once, at claim (turn.rs) — the same one-line clear —
    // and the next turn runs clean.
    turn_loop.stop_flag("t1").store(false, Ordering::SeqCst);
    let mut ex2 = Script::new(vec![text_step("after")]);
    let report = turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut ex2,
            TurnPlan {
                thread_id: "t1",
                user_text: "go again",
                prepared: &prepared(available_tools()),
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("second turn");
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
}

// ── regenerate / continue-append (D99, D106) ────────────────────────────────

/// Text of every `text` block by role, in surface order.
fn role_texts(store: &Store, role: &str) -> Vec<String> {
    store
        .blocks_for_thread("t1")
        .into_iter()
        .filter(|b| b.role == role && b.kind == "text")
        .map(|b| {
            serde_json::from_str::<serde_json::Value>(&b.payload)
                .expect("text payload")
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect()
}

#[test]
fn regenerate_appends_new_answer_history_untouched() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let tools = prepared(available_tools());
    let mut turn_loop = TurnLoop::new();
    turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut Script::new(vec![text_step("first a")]),
            TurnPlan {
                thread_id: "t1",
                user_text: "first q",
                prepared: &tools,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn runs");
    turn_loop
        .regenerate_last(
            &store,
            &mut reg,
            &mut Script::new(vec![text_step("second a")]),
            "t1",
            &tools,
            &dir.path,
            &mut |_| {},
        )
        .expect("regenerate runs");
    // D99: new rows, never rewritten. The user text reappears as a new row
    // carrying the same words; the first answer is byte-identical.
    assert_eq!(role_texts(&store, "user"), vec!["first q", "first q"]);
    assert_eq!(role_texts(&store, "assistant"), vec!["first a", "second a"]);
}

#[test]
fn continue_turn_adds_no_user_message() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let tools = prepared(available_tools());
    let mut turn_loop = TurnLoop::new();
    turn_loop
        .run_turn(
            &store,
            &mut reg,
            &mut Script::new(vec![text_step("part one")]),
            TurnPlan {
                thread_id: "t1",
                user_text: "go",
                prepared: &tools,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn runs");
    // D106: finishing a turn appends assistant rows, not another user row.
    turn_loop
        .continue_turn(
            &store,
            &mut reg,
            &mut Script::new(vec![text_step("part two")]),
            "t1",
            &tools,
            &dir.path,
            &mut |_| {},
        )
        .expect("continue runs");
    assert_eq!(role_texts(&store, "user"), vec!["go"]);
    assert_eq!(
        role_texts(&store, "assistant"),
        vec!["part one", "part two"]
    );
}

#[test]
fn regenerate_without_prior_user_text_fails_typed() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let tools = prepared(available_tools());
    let mut turn_loop = TurnLoop::new();
    let err = turn_loop
        .regenerate_last(
            &store,
            &mut reg,
            &mut Script::new(vec![text_step("x")]),
            "t1",
            &tools,
            &dir.path,
            &mut |_| {},
        )
        .expect_err("no user text to regenerate");
    assert!(
        matches!(err, LoopError::Store(_)),
        "typed store error, never a panic: {err:?}"
    );
}

#[test]
fn drained_queue_runs_in_order_as_separate_turns() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let tools = prepared(available_tools());
    let mut turn_loop = TurnLoop::new();
    // Two follow-ups queued before the first turn runs (D98: appends, never
    // blocks; D105: in-order turns, never merged).
    turn_loop.send_while_busy("t1", "second q");
    turn_loop.send_while_busy("t1", "third q");
    let mut ex = Script::new(vec![
        text_step("first a"),
        text_step("second a"),
        text_step("third a"),
    ]);
    let report = turn_loop
        .run_turn_drained(
            &store,
            &mut reg,
            &mut ex,
            TurnPlan {
                thread_id: "t1",
                user_text: "first q",
                prepared: &tools,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("drained run");
    assert_eq!(report.end, TurnEnd::EndTurn);
    assert_eq!(report.assistant_messages, 3);
    assert_eq!(
        role_texts(&store, "user"),
        vec!["first q", "second q", "third q"]
    );
    assert_eq!(
        role_texts(&store, "assistant"),
        vec!["first a", "second a", "third a"]
    );
    assert!(
        turn_loop.drain_next("t1").is_none(),
        "the queue is empty afterwards"
    );
}

#[test]
fn empty_queue_runs_exactly_one_turn() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let tools = prepared(available_tools());
    let mut turn_loop = TurnLoop::new();
    let report = turn_loop
        .run_turn_drained(
            &store,
            &mut reg,
            &mut Script::new(vec![text_step("only a")]),
            TurnPlan {
                thread_id: "t1",
                user_text: "only q",
                prepared: &tools,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("drained run");
    assert_eq!(report.end, TurnEnd::EndTurn);
    assert_eq!(report.assistant_messages, 1);
}

#[test]
fn failed_first_turn_does_not_drain() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let tools = prepared(available_tools());
    let mut turn_loop = TurnLoop::new();
    turn_loop.send_while_busy("t1", "queued q");
    let report = turn_loop
        .run_turn_drained(
            &store,
            &mut reg,
            &mut Script::failing_after(text_step("first a"), "boom"),
            TurnPlan {
                thread_id: "t1",
                user_text: "first q",
                prepared: &tools,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("drained run");
    assert_eq!(report.end, TurnEnd::TransportError);
    // The queued input became a turn and stays in history (D68) — it is
    // consumed, not lost and not silently dropped. A retry continues from
    // the transcript; re-queueing would duplicate the row.
    assert_eq!(role_texts(&store, "user"), vec!["first q", "queued q"]);
    assert_eq!(role_texts(&store, "assistant"), vec!["first a"]);
    assert!(
        turn_loop.drain_next("t1").is_none(),
        "consumed input is history now, not queue"
    );
}

#[test]
fn continue_drained_resumes_then_drains() {
    let dir = TestDir::fresh();
    let defs = clauro_tools::eight_definitions();
    let (_, hash) = first_turn_setup(&defs, None);
    let store = seeded(&dir, "t1", &hash);
    let mut reg = Registry::with_eight();
    let tools = prepared(available_tools());
    let mut turn_loop = TurnLoop::new();
    turn_loop.send_while_busy("t1", "queued q");
    let report = turn_loop
        .continue_turn_drained(
            &store,
            &mut reg,
            &mut Script::new(vec![text_step("part one"), text_step("part two")]),
            "t1",
            &tools,
            &dir.path,
            &mut |_| {},
        )
        .expect("drained continue");
    assert_eq!(report.end, TurnEnd::EndTurn);
    // The resume appends no user row; the drained item does.
    assert_eq!(role_texts(&store, "user"), vec!["queued q"]);
    assert_eq!(
        role_texts(&store, "assistant"),
        vec!["part one", "part two"]
    );
}
