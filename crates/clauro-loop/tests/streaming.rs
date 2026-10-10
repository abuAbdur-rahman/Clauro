//! Task 006 — streaming delivery of a step (RED).
//!
//! `Exchange::step` hands the loop a whole `Vec<NormalisedEvent>`, so a
//! provider response is only visible once it has finished. Nothing that
//! renders can therefore show text as it arrives.
//!
//! This file pins the fix: `step` also takes a **sink**, called once per event
//! as it is produced, and the loop forwards events to it while it persists.
//! The returned vector stays, so persistence is unchanged and a caller that
//! ignores the sink sees exactly the old behaviour.
//!
//! D100's "at most once per frame" is a view-layer rule; what is provable
//! here is that each event reaches the sink exactly once, in order, and that
//! persistence still sees the complete step.

use clauro_loop::run::{Exchange, ExchangeFailure, PreparedThread, TurnLoop, TurnPlan};
use clauro_store::{NewProject, NewThread, Store};
use clauro_tools::Registry;
use clauro_transport::{BuiltRequest, InboundKind, NormalisedEvent};
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
        let path =
            std::env::temp_dir().join(format!("clauro-006-stream-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).expect("scratch");
        Self { path }
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Scripted provider that pushes each event through the sink as it yields it,
/// the way a real SSE reader would: incrementally, not as one finished batch.
struct StreamingScript {
    steps: VecDeque<Vec<NormalisedEvent>>,
}

impl StreamingScript {
    fn new(steps: Vec<Vec<NormalisedEvent>>) -> Self {
        Self {
            steps: steps.into_iter().collect(),
        }
    }
}

impl Exchange for StreamingScript {
    fn step(
        &mut self,
        _request: &BuiltRequest,
        sink: &mut dyn FnMut(NormalisedEvent),
    ) -> Result<Vec<NormalisedEvent>, ExchangeFailure> {
        let events = self.steps.pop_front().expect("script exhausted");
        let mut out = Vec::with_capacity(events.len());
        for event in events {
            sink(event.clone());
            out.push(event);
        }
        Ok(out)
    }
}

fn text_step(words: &[&str]) -> Vec<NormalisedEvent> {
    let mut events = vec![NormalisedEvent::BlockStart {
        index: 0,
        kind: InboundKind::Text,
        tool: None,
    }];
    for w in words {
        events.push(NormalisedEvent::BlockDelta {
            index: 0,
            text: Some((*w).to_string()),
            signature: None,
        });
    }
    events.push(NormalisedEvent::BlockStop { index: 0 });
    events
}

fn thread_with_frozen(store: &Store, hash: &str) -> String {
    let project = NewProject {
        id: "p1".into(),
        name: "P".into(),
        instructions: String::new(),
        bash_enabled: false,
    };
    store.insert_project(project).expect("project");
    let id = "t1".to_string();
    store
        .insert_thread(NewThread {
            id: id.clone(),
            project_id: Some("p1".into()),
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: hash.to_string(),
            tools_frozen: String::new(),
        })
        .expect("thread");
    id
}

fn prepared(frozen: &str) -> PreparedThread {
    PreparedThread {
        system_text: "s".into(),
        frozen_hash: frozen.to_string(),
        model: "m".into(),
        max_tokens: 1024,
        tools: Vec::new(),
        thinking_budget: 0,
        rules: Vec::new(),
    }
}

/// The sink receives events as the step produces them, before the step
/// returns — this is what lets a view render mid-response.
#[test]
fn sink_sees_each_event_before_the_step_returns() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.path.join("s.db")).expect("store");
    let thread = thread_with_frozen(&store, "h");
    let prep = prepared("h");
    let mut loop_ = TurnLoop::new();
    let mut registry = Registry::with_eight();
    let mut exchange = StreamingScript::new(vec![text_step(&["one", "two", "three"])]);

    let mut seen: Vec<String> = Vec::new();
    {
        let mut sink = |event: NormalisedEvent| {
            // Recorded here, while the exchange is mid-step.
            if let NormalisedEvent::BlockDelta { text: Some(t), .. } = event {
                seen.push(t);
            }
        };
        loop_
            .run_turn(
                &store,
                &mut registry,
                &mut exchange,
                TurnPlan {
                    thread_id: &thread,
                    user_text: "hi",
                    prepared: &prep,
                    workspace_dir: &dir.path,
                },
                &mut sink,
            )
            .expect("turn");
    }

    assert_eq!(seen, vec!["one", "two", "three"]);
}

/// A caller that passes no sink sees exactly the pre-existing behaviour:
/// persistence is complete and identical.
#[test]
fn persistence_is_unchanged_when_the_sink_is_ignored() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.path.join("s.db")).expect("store");
    let thread = thread_with_frozen(&store, "h");
    let prep = prepared("h");
    let mut loop_ = TurnLoop::new();
    let mut registry = Registry::with_eight();
    let mut exchange = StreamingScript::new(vec![text_step(&["alpha", "beta"])]);

    let report = loop_
        .run_turn(
            &store,
            &mut registry,
            &mut exchange,
            TurnPlan {
                thread_id: &thread,
                user_text: "hi",
                prepared: &prep,
                workspace_dir: &dir.path,
            },
            &mut |_| {},
        )
        .expect("turn");

    assert_eq!(report.assistant_messages, 1);
    let blocks = store.blocks_for_thread(&thread);
    // The user turn is itself a text block, so scope this to the assistant
    // message: three deltas must collapse to ONE persisted text block.
    let assistant_text: Vec<_> = blocks
        .iter()
        .filter(|b| b.kind == "text" && b.role == "assistant")
        .collect();
    assert_eq!(
        assistant_text.len(),
        1,
        "one assistant text block, not one per delta"
    );
    assert!(
        assistant_text[0].payload.contains("alpha") && assistant_text[0].payload.contains("beta"),
        "the whole step is persisted: {}",
        assistant_text[0].payload
    );
}

/// The sink sees deltas, not only block boundaries: a caller must be able to
/// append text mid-turn rather than after `end_turn`.
#[test]
fn deltas_reach_the_sink_before_the_block_closes() {
    let dir = TestDir::fresh();
    let store = Store::open(&dir.path.join("s.db")).expect("store");
    let thread = thread_with_frozen(&store, "h");
    let prep = prepared("h");
    let mut loop_ = TurnLoop::new();
    let mut registry = Registry::with_eight();
    let mut exchange = StreamingScript::new(vec![text_step(&["partial"])]);

    let mut order: Vec<&'static str> = Vec::new();
    let mut sink = |event: NormalisedEvent| {
        let kind = match event {
            NormalisedEvent::BlockStart { .. } => "start",
            NormalisedEvent::BlockDelta { .. } => "delta",
            NormalisedEvent::BlockStop { .. } => "stop",
            _ => "other",
        };
        order.push(kind);
    };

    loop_
        .run_turn(
            &store,
            &mut registry,
            &mut exchange,
            TurnPlan {
                thread_id: &thread,
                user_text: "hi",
                prepared: &prep,
                workspace_dir: &dir.path,
            },
            &mut sink,
        )
        .expect("turn");

    assert_eq!(order, vec!["start", "delta", "stop"]);
}
