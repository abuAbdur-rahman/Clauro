//! Phase 3 gate e2e (`Tasks/028`, D113): the `artifact` tool through the real loop.
//!
//! What the handler unit tests (`clauro-tools/tests/artifact.rs`) cannot prove:
//! the loop dispatches `artifact` through permissions/approval/bounding into
//! versioned rows, source bytes, and paired transcript results. Three turns:
//! create → refresh (history intact) → ask-held create (approval gate).
//! No network, no webview: engine-observable criteria stay open to `021` by
//! rule, and this file does not claim them.

use clauro_loop::prompt::first_turn_setup;
use clauro_loop::run::{Exchange, ExchangeFailure, PreparedThread, TurnEnd, TurnLoop, TurnPlan};
use clauro_store::{NewProject, NewThread, Store};
use clauro_tools::{register_artifact, FsHost};
use clauro_transport::{BuiltRequest, InboundKind, NormalisedEvent, ToolHeader};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Trees {
    // Two handles, one file: `main` drives the loop and asserts, `shared`
    // feeds the handler. Never hold a lock across `run_turn` — the handler
    // locks per call, so a held guard deadlocks the turn.
    main: Store,
    shared: Arc<Mutex<Store>>,
    tmp: PathBuf,
    session: PathBuf,
    project: PathBuf,
}

fn trees() -> Trees {
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = loop {
        let candidate =
            std::env::temp_dir().join(format!("clauro-e2e3-{}-{n}-{stamp}", std::process::id()));
        if std::fs::create_dir(&candidate).is_ok() {
            break candidate;
        }
        stamp += 1;
    };
    let session = tmp.join("sessions").join("s1-t");
    let project = tmp.join("projects").join("p1-p");
    std::fs::create_dir_all(&session).expect("session");
    std::fs::create_dir_all(&project).expect("project");
    let db_path = tmp.join("test.db");
    let inner = Store::open(&db_path).expect("db");
    inner
        .insert_project(NewProject {
            id: "p1".to_string(),
            name: "proj".to_string(),
            instructions: String::new(),
            bash_enabled: false,
        })
        .expect("project");
    Trees {
        main: inner,
        shared: Arc::new(Mutex::new(Store::open(&db_path).expect("second handle"))),
        tmp,
        session,
        project,
    }
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
}

impl Exchange for Script {
    fn step(&mut self, _request: &BuiltRequest) -> Result<Vec<NormalisedEvent>, ExchangeFailure> {
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

fn artifact_input(title: &str, source: &str, id: &str) -> String {
    serde_json::json!({
        "title": title,
        "mediaType": "text/html",
        "source": source,
        "artifactId": id,
    })
    .to_string()
}

struct Fixture {
    trees: Trees,
    reg: clauro_tools::Registry,
    prepared: PreparedThread,
    turn_loop: TurnLoop,
}

fn fixture(granted: &[&str], rules: Vec<clauro_core::PermissionRule>) -> Fixture {
    let trees = trees();
    let defs = clauro_tools::eight_definitions();
    let (system_text, frozen_hash) = first_turn_setup(&defs, None);
    trees
        .main
        .insert_thread(NewThread {
            id: "t1".to_string(),
            project_id: Some("p1".to_string()),
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: frozen_hash.clone(),
            tools_frozen: "[]".to_string(),
        })
        .expect("thread");
    let mut reg = clauro_tools::Registry::with_eight();
    let fshost = Arc::new(
        FsHost::new(
            &trees.session,
            &trees.project,
            Some("p1".to_string()),
            trees.shared.clone(),
        )
        .expect("fs host"),
    );
    register_artifact(&mut reg, fshost);
    let granted_tools: Vec<clauro_tools::MaterializedTool> = {
        use clauro_tools::{materialize, ThreadToolState};
        let mut state = ThreadToolState::default();
        for name in granted {
            state.granted.insert((*name).to_string());
        }
        materialize(None, &state).anthropic_tools
    };
    Fixture {
        trees,
        reg,
        prepared: PreparedThread {
            system_text,
            frozen_hash: frozen_hash.clone(),
            model: "claude-x".to_string(),
            max_tokens: 1024,
            tools: granted_tools,
            thinking_budget: 10_000,
            rules,
        },
        turn_loop: TurnLoop::new(),
    }
}

fn run_script(
    f: &mut Fixture,
    steps: Vec<Vec<NormalisedEvent>>,
    user_text: &str,
) -> clauro_loop::run::TurnReport {
    let mut exchange = Script {
        steps: VecDeque::from(steps),
    };
    f.turn_loop
        .run_turn(
            &f.trees.main,
            &mut f.reg,
            &mut exchange,
            TurnPlan {
                thread_id: "t1",
                user_text,
                prepared: &f.prepared,
                workspace_dir: &f.trees.session,
            },
        )
        .expect("turn must run")
}

fn source_bytes(session: &Path, store: &Store, artifact_id: &str, version: i64) -> Vec<u8> {
    // DB row and filesystem must agree: the recorded path names the file that
    // exists. A layout change that moves one side without the other fails here.
    let recorded = store
        .artifact_source_path("t1", artifact_id, version)
        .unwrap_or_else(|| panic!("{artifact_id} v{version} row exists"));
    assert_eq!(
        recorded,
        format!("artifacts/{artifact_id}-{version}/source"),
        "row names the versioned file"
    );
    let path = session.join(&recorded);
    assert!(path.is_file(), "recorded path exists on disk: {recorded}");
    std::fs::read(&path).expect("source reads")
}

fn assert_paired(f: &Fixture) {
    let results = f.trees.main.tool_results_for_thread("t1");
    let pairing = clauro_store::transcript::find_unpaired_tool_uses(
        &f.trees.main.blocks_for_thread("t1"),
        &results,
    );
    assert!(pairing.unpaired.is_empty(), "{pairing:?}");
}

#[test]
fn artifact_turn_persists_versioned_source_and_pairs_result() {
    let mut f = fixture(&["artifact"], vec![]);
    let report = run_script(
        &mut f,
        vec![
            tool_step(
                "c-art",
                "artifact",
                &artifact_input("Demo", "<h1>hi</h1>", "a1"),
            ),
            text_step("done"),
        ],
        "render this",
    );
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
    assert_eq!(report.dispatched, vec!["c-art".to_string()], "{report:?}");

    let results = f.trees.main.tool_results_for_thread("t1");
    assert_eq!(results.len(), 1, "every dispatch persisted a result");
    assert_eq!(
        results[0].status,
        clauro_core::ToolStatus::Ok,
        "{results:?}"
    );
    let full = f
        .trees
        .main
        .get_tool_result_full("t1", "c-art")
        .expect("row must exist");
    assert!(
        full.preview.contains("Demo") && full.preview.contains('1'),
        "{full:?}"
    );
    assert_eq!(
        f.trees.main.max_artifact_version("t1", "a1"),
        Some(1),
        "one live version"
    );
    assert_eq!(
        source_bytes(&f.trees.session, &f.trees.main, "a1", 1),
        b"<h1>hi</h1>",
        "bytes match the input, not a preview of it"
    );
    assert_paired(&f);
}

#[test]
fn artifact_refresh_through_the_loop_bumps_version_and_keeps_v1() {
    let mut f = fixture(&["artifact"], vec![]);
    run_script(
        &mut f,
        vec![
            tool_step("c-1", "artifact", &artifact_input("D", "v1 body", "a9")),
            text_step("first"),
        ],
        "render v1",
    );
    let report = run_script(
        &mut f,
        vec![
            tool_step("c-2", "artifact", &artifact_input("D", "v2 body", "a9")),
            text_step("second"),
        ],
        "revise it",
    );
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");

    assert_eq!(
        f.trees.main.max_artifact_version("t1", "a9"),
        Some(2),
        "refresh bumps, never rewrites"
    );
    assert_eq!(
        source_bytes(&f.trees.session, &f.trees.main, "a9", 1),
        b"v1 body",
        "history intact across turns"
    );
    assert_eq!(
        source_bytes(&f.trees.session, &f.trees.main, "a9", 2),
        b"v2 body",
        "new version stored"
    );
    let results = f.trees.main.tool_results_for_thread("t1");
    assert_eq!(results.len(), 2, "{results:?}");
    assert_paired(&f);
}

#[test]
fn artifact_under_ask_holds_then_dispatches_after_approve() {
    let mut f = fixture(
        &["artifact"],
        vec![clauro_core::PermissionRule {
            effect: clauro_core::Effect::Ask,
            tool: "artifact".to_string(),
        }],
    );
    let mut first = Script {
        steps: VecDeque::from([tool_step(
            "h1",
            "artifact",
            &artifact_input("Held", "<p>held</p>", "h1"),
        )]),
    };
    let report = f
        .turn_loop
        .run_turn(
            &f.trees.main,
            &mut f.reg,
            &mut first,
            TurnPlan {
                thread_id: "t1",
                user_text: "render, pending approval",
                prepared: &f.prepared,
                workspace_dir: &f.trees.session,
            },
        )
        .expect("turn runs");
    assert_eq!(report.end, TurnEnd::AwaitingApproval, "{report:?}");
    assert_eq!(report.pending_approvals, vec!["h1".to_string()]);
    assert_eq!(
        f.trees.main.max_artifact_version("t1", "h1"),
        None,
        "held means unpersisted: no rows before approval"
    );

    f.turn_loop.approve_call("t1", "h1").expect("approve");
    let report = run_script(&mut f, vec![text_step("thanks")], "go on");
    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
    assert_eq!(
        f.trees.main.max_artifact_version("t1", "h1"),
        Some(1),
        "approved call persisted exactly once"
    );
    assert_eq!(
        source_bytes(&f.trees.session, &f.trees.main, "h1", 1),
        b"<p>held</p>",
        "approved bytes are the held bytes"
    );
    assert_paired(&f);
}
