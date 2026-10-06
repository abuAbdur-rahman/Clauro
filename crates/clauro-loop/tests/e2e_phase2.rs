//! Whole-phase e2e: one turn across every Phase 0–2 component.
//!
//! Seeds a real store, binds the real handlers (`memory`, `question`, `fs`,
//! `web-fetch`), scripts a provider exchange (fs read → memory create →
//! web-fetch → `end_turn`), and asserts the transcript rows, I1 pairing, and
//! the memory write. No network: the exchange and the HTTP getter are both
//! scripted. What this cannot prove (UI render, live providers, keyring) is
//! named, not implied.

use clauro_loop::prompt::first_turn_setup;
use clauro_loop::run::{Exchange, ExchangeFailure, PreparedThread, TurnEnd, TurnLoop, TurnPlan};
use clauro_store::{NewProject, NewThread, Store};
use clauro_tools::{
    register_fs, register_question, register_web, FetchConfig, FsHost, HttpResponse,
};
use clauro_transport::{BuiltRequest, InboundKind, NormalisedEvent, ToolHeader};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Trees {
    // Two handles, one file. `main` drives the loop and asserts; `shared`
    // feeds the handlers. Never one mutex held across `run_turn` — handlers
    // lock per call, so a held guard deadlocks the turn (found the hard way).
    main: Store,
    shared: Arc<Mutex<Store>>,
    tmp: PathBuf,
    session: PathBuf,
    project: PathBuf,
}

fn trees() -> Trees {
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    // Fresh by construction: pid + counter + nanos, and never reuse an
    // existing dir (Windows reuses pids; a crashed run's litter must not
    // become this run's dirty database).
    let mut stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = loop {
        let candidate =
            std::env::temp_dir().join(format!("clauro-e2e-{}-{n}-{stamp}", std::process::id()));
        if std::fs::create_dir(&candidate).is_ok() {
            break candidate;
        }
        stamp += 1;
    };
    let session = tmp.join("sessions").join("s1-title");
    let project = tmp.join("projects").join("p1-proj");
    std::fs::create_dir_all(&session).expect("session");
    std::fs::create_dir_all(&project).expect("project");
    std::fs::write(session.join("hello.txt"), "hello e2e").expect("seed file");
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
        // Windows may briefly hold a fresh DB file (indexer/AV); retry
        // instead of littering. pid-unique names keep any leftover harmless.
        for _ in 0..25 {
            match std::fs::remove_dir_all(&self.tmp) {
                Ok(()) => return,
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
            }
        }
        eprintln!("E2E_DROP_FAILED {:?}", self.tmp);
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

fn fake_http(_req: &clauro_tools::HttpRequest) -> Result<HttpResponse, clauro_tools::HttpError> {
    Ok(HttpResponse {
        status: 200,
        headers: vec![("content-type".to_string(), "text/html".to_string())],
        body_bytes: b"<html><body><p>Fetched page.</p></body></html>".to_vec(),
    })
}

#[test]
fn phase_two_turn_runs_end_to_end() {
    let t = trees();
    let defs = clauro_tools::eight_definitions();
    let (system_text, frozen_hash) = first_turn_setup(&defs, None);
    {
        let store = &t.main;
        store
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
    }

    let mut reg = clauro_tools::Registry::with_eight();
    reg.set_handler("memory", clauro_tools::memory_handler(t.shared.clone()))
        .expect("bind memory");
    register_question(&mut reg);
    let fshost = Arc::new(
        FsHost::new(
            &t.session,
            &t.project,
            Some("p1".to_string()),
            t.shared.clone(),
        )
        .expect("fs host"),
    );
    register_fs(&mut reg, fshost);
    let webhost = Arc::new(clauro_tools::WebHost {
        search: clauro_tools::SearchConfig {
            endpoint: "https://search.test".to_string(),
            api_key: None,
        },
        fetch: FetchConfig {
            max_bytes: 10_000,
            max_redirects: 3,
        },
        get: Arc::new(fake_http),
    });
    register_web(&mut reg, webhost);

    let granted: Vec<clauro_tools::MaterializedTool> = {
        use clauro_tools::{materialize, ThreadToolState};
        let mut state = ThreadToolState::default();
        for name in ["memory", "fs", "web-fetch", "question"] {
            state.granted.insert(name.to_string());
        }
        materialize(None, &state).anthropic_tools
    };
    let prepared = PreparedThread {
        system_text,
        frozen_hash,
        model: "claude-x".to_string(),
        max_tokens: 1024,
        tools: granted,
        thinking_budget: 10_000,
        rules: Vec::new(),
    };

    let mut exchange = Script {
        steps: VecDeque::from([
            tool_step("c-fs", "fs", r#"{"command":"read","path":"hello.txt"}"#),
            tool_step(
                "c-mem",
                "memory",
                r#"{"command":"create","path":"/memories/e2e","body":"e2e note"}"#,
            ),
            tool_step("c-web", "web-fetch", r#"{"url":"https://x.example/"}"#),
            text_step("done"),
        ]),
    };
    let mut turn_loop = TurnLoop::new();
    let report = turn_loop
        .run_turn(
            &t.main,
            &mut reg,
            &mut exchange,
            TurnPlan {
                thread_id: "t1",
                user_text: "read the file, remember this, fetch that page",
                prepared: &prepared,
                workspace_dir: &t.session,
            },
        )
        .expect("turn must run");

    assert_eq!(report.end, TurnEnd::EndTurn, "{report:?}");
    assert_eq!(
        report.dispatched,
        vec!["c-fs", "c-mem", "c-web"],
        "{report:?}"
    );

    let store = &t.main;
    let results = store.tool_results_for_thread("t1");
    assert_eq!(results.len(), 3, "every dispatch persisted a result");
    assert!(
        results
            .iter()
            .all(|r| r.status == clauro_core::ToolStatus::Ok),
        "{results:?}"
    );
    let pairing =
        clauro_store::transcript::find_unpaired_tool_uses(&store.blocks_for_thread("t1"), &results);
    assert!(pairing.unpaired.is_empty(), "{pairing:?}");
    let memories = store.list_memories(Some("p1")).expect("list");
    assert!(
        memories
            .iter()
            .any(|m| m.path == "/memories/e2e" && m.body == "e2e note"),
        "memory write survived the turn"
    );
}
