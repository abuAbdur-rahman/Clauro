//! Task 006 — middle-removal surfacing (RED).
//!
//! Detection exists (`unbroken_run_end`, tested in clauro-core) but has no
//! caller: a thinking block removed from the middle of a run re-sends its
//! later blocks as if the run were whole, and nothing says otherwise.
//!
//! The contract this file pins:
//! - when the stored thinking history has a gap (a dropped or
//!   signature-less block in the middle of a run), the request re-sends only
//!   the unbroken prefix — later thinking blocks are withheld, never replayed
//!   into a verification that must fail (D72);
//! - the transcript says so exactly once: a `notice` row naming the withheld
//!   count, deduplicated across turns (one notice per gap, not per turn);
//! - a whole run re-sends byte-identical with no notice at all.

use clauro_loop::run::{Exchange, ExchangeFailure, PreparedThread, TurnEnd, TurnLoop, TurnPlan};
use clauro_store::{MessageRole, NewBlock, NewMessage, NewProject, NewThread, Store};
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
        let path = std::env::temp_dir().join(format!("clauro-006-gap-{}-{n}", std::process::id()));
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
    pub bodies: Vec<serde_json::Value>,
}

impl Script {
    fn new(steps: Vec<Vec<NormalisedEvent>>) -> Self {
        Self {
            steps: steps.into_iter().collect(),
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
        let events = self.steps.pop_front().expect("script exhausted");
        for event in &events {
            sink(event.clone());
        }
        Ok(events)
    }
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

/// Seed a thread whose assistant history carries three thinking blocks: two
/// whole, one broken in the middle (no signature — the observable shape of a
/// block that cannot verify and must not anchor a re-send).
fn seeded_with_gap(dir: &TestDir) -> Store {
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
            system_frozen: "h".to_string(),
            tools_frozen: String::new(),
        })
        .expect("thread");
    let msg = "m-old".to_string();
    store
        .insert_message(NewMessage {
            id: msg.clone(),
            thread_id: "t1".to_string(),
            seq: 1,
            role: MessageRole::Assistant,
            created_at: 0,
        })
        .expect("message");
    let thinking = [
        (
            r#"{"text":"first thought","display":"full"}"#,
            Some("sig-a"),
        ),
        (r#"{"text":"lost thought","display":"full"}"#, None),
        (
            r#"{"text":"later thought","display":"full"}"#,
            Some("sig-c"),
        ),
    ];
    for (i, (payload, signature)) in thinking.iter().enumerate() {
        store
            .insert_block(NewBlock {
                id: format!("bh{i}"),
                message_id: msg.clone(),
                seq: i as i64,
                kind: "thinking".to_string(),
                payload: (*payload).to_string(),
                boundary: None,
                is_summary: false,
                generation: 0,
                signature: signature.map(str::to_string),
                dropped: false,
            })
            .expect("block");
    }
    store
}

fn prepared() -> PreparedThread {
    PreparedThread {
        system_text: "s".into(),
        frozen_hash: "h".to_string(),
        model: "m".into(),
        max_tokens: 1024,
        tools: Vec::new(),
        thinking_budget: 0,
        rules: Vec::new(),
    }
}

/// Thinking text the provider request actually carries, in order.
fn request_thinking(body: &serde_json::Value) -> Vec<String> {
    body.get("messages")
        .and_then(|m| m.as_array())
        .map(|msgs| {
            msgs.iter()
                .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("assistant"))
                .flat_map(|m| {
                    m.get("content")
                        .and_then(|c| c.as_array())
                        .cloned()
                        .unwrap_or_default()
                })
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("thinking"))
                .filter_map(|b| {
                    b.get("thinking")
                        .and_then(|t| t.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn gap_notices(store: &Store) -> Vec<String> {
    store
        .blocks_for_thread("t1")
        .into_iter()
        .filter(|b| b.kind == "notice")
        .filter_map(|b| {
            serde_json::from_str::<serde_json::Value>(&b.payload)
                .ok()?
                .get("text")?
                .as_str()
                .map(str::to_string)
        })
        .filter(|t| t.contains("thinking history has a gap"))
        .collect()
}

/// Later thinking blocks are withheld from the request, and the transcript
/// says so.
#[test]
fn broken_run_withholds_later_thinking_and_surfaces_a_notice() {
    let dir = TestDir::fresh();
    let store = seeded_with_gap(&dir);
    let prep = prepared();
    let mut loop_ = TurnLoop::new();
    let mut reg = Registry::with_eight();
    let mut ex = Script::new(vec![text_step("done")]);

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
    let thinking = request_thinking(&ex.bodies[0]);
    assert_eq!(
        thinking,
        vec!["first thought".to_string()],
        "only the unbroken prefix re-sends; 'later thought' is withheld"
    );
    let notices = gap_notices(&store);
    assert_eq!(notices.len(), 1, "exactly one gap notice, naming the count");
    assert!(
        notices[0].contains('1'),
        "the notice names the withheld count: {}",
        notices[0]
    );
}

/// The notice is per gap, not per turn: a second turn adds no duplicate.
#[test]
fn gap_notice_is_deduplicated_across_turns() {
    let dir = TestDir::fresh();
    let store = seeded_with_gap(&dir);
    let prep = prepared();
    let mut loop_ = TurnLoop::new();
    let mut reg = Registry::with_eight();
    let mut ex = Script::new(vec![text_step("one"), text_step("two")]);
    for text in ["first", "second"] {
        loop_
            .run_turn(
                &store,
                &mut reg,
                &mut ex,
                TurnPlan {
                    thread_id: "t1",
                    user_text: text,
                    prepared: &prep,
                    workspace_dir: &dir.path,
                },
                &mut |_| {},
            )
            .expect("turn runs");
    }
    assert_eq!(
        gap_notices(&store).len(),
        1,
        "one gap, one notice — never per-turn spam"
    );
}

/// A whole run re-sends byte-identical with no notice.
#[test]
fn whole_run_resends_everything_with_no_notice() {
    let dir = TestDir::fresh();
    // Fresh database with all three signatures intact (append-only forbids
    // repairing the gapped one, so the control builds its own history).
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
            system_frozen: "h".to_string(),
            tools_frozen: String::new(),
        })
        .expect("thread");
    let msg = "m-old".to_string();
    store
        .insert_message(NewMessage {
            id: msg.clone(),
            thread_id: "t1".to_string(),
            seq: 1,
            role: MessageRole::Assistant,
            created_at: 0,
        })
        .expect("message");
    for (i, text) in ["first thought", "kept thought", "later thought"]
        .iter()
        .enumerate()
    {
        store
            .insert_block(NewBlock {
                id: format!("bh{i}"),
                message_id: msg.clone(),
                seq: i as i64,
                kind: "thinking".to_string(),
                payload: format!(r#"{{"text":"{text}","display":"full"}}"#),
                boundary: None,
                is_summary: false,
                generation: 0,
                signature: Some(format!("sig-{i}")),
                dropped: false,
            })
            .expect("block");
    }
    let prep = prepared();
    let mut loop_ = TurnLoop::new();
    let mut reg = Registry::with_eight();
    let mut ex = Script::new(vec![text_step("done")]);
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

    assert_eq!(
        request_thinking(&ex.bodies[0]),
        vec![
            "first thought".to_string(),
            "kept thought".to_string(),
            "later thought".to_string()
        ]
    );
    assert!(
        gap_notices(&store).is_empty(),
        "a whole run notices nothing"
    );
}
