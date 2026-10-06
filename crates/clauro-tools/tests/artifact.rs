//! Task 013 — the artifact tool writes versioned sources (RED).
//!
//! Our schema (D1): `{title, mediaType, source}` plus an optional
//! `artifactId` for refresh — absent means a new artifact. One live artifact
//! per `(thread, artifact_id)`; refresh bumps `version`, never rewrites.
//! Media allowlist is exactly what the frame can render: HTML and SVG.

use clauro_core::{ToolContext, ToolOutcome};
use clauro_store::Store;
use clauro_tools::{register_artifact, FsHost};
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Trees {
    store: Arc<Mutex<Store>>,
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
            std::env::temp_dir().join(format!("clauro-013-{}-{n}-{stamp}", std::process::id()));
        if std::fs::create_dir(&candidate).is_ok() {
            break candidate;
        }
        stamp += 1;
    };
    let session = tmp.join("sessions").join("s1-t");
    let project = tmp.join("projects").join("p1-p");
    std::fs::create_dir_all(&session).expect("session");
    std::fs::create_dir_all(&project).expect("project");
    let store = Arc::new(Mutex::new(Store::open(&tmp.join("t.db")).expect("db")));
    store
        .lock()
        .expect("lock")
        .insert_thread(clauro_store::NewThread {
            id: "t1".to_string(),
            project_id: None,
            title: None,
            incognito: false,
            memory_off: false,
            system_frozen: "s".to_string(),
            tools_frozen: "[]".to_string(),
        })
        .expect("thread");
    Trees {
        store,
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

fn host(t: &Trees) -> (clauro_tools::Registry, u64) {
    let h = Arc::new(
        FsHost::new(
            &t.session,
            &t.project,
            Some("p1".to_string()),
            t.store.clone(),
        )
        .expect("host"),
    );
    let mut reg = clauro_tools::Registry::with_eight();
    register_artifact(&mut reg, h);
    let epoch = reg.materialize().epoch;
    (reg, epoch)
}

fn ctx() -> ToolContext {
    ToolContext {
        thread_id: "t1".to_string(),
        call_id: "c1".to_string(),
        workspace_dir: PathBuf::from("/tmp/ws"),
    }
}

fn run(reg: &clauro_tools::Registry, epoch: u64, input: serde_json::Value) -> ToolOutcome {
    reg.dispatch(
        &clauro_tools::IncomingCall {
            name: "artifact".to_string(),
            input,
            epoch,
        },
        &ctx(),
    )
}

fn ok_text(out: ToolOutcome) -> String {
    match out {
        ToolOutcome::Ok { preview, .. } => preview,
        other => panic!("expected ok, got: {other:?}"),
    }
}

#[test]
fn html_artifact_stores_source_v1() {
    let t = trees();
    let (reg, epoch) = host(&t);
    let preview = ok_text(run(
        &reg,
        epoch,
        json!({"title": "Demo", "mediaType": "text/html", "source": "<h1>hi</h1>"}),
    ));
    assert!(
        preview.contains("Demo") && preview.contains('1'),
        "{preview}"
    );
    let found: Vec<PathBuf> = walk(&t.session);
    assert!(
        found.iter().any(|p| {
            let s = p.to_string_lossy().replace('\\', "/");
            s.ends_with("-1/source")
        }),
        "source under version dir: {found:?}"
    );
}

fn walk(root: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).expect("list").filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out
}

#[test]
fn refresh_same_id_bumps_version_never_rewrites() {
    let t = trees();
    let (reg, epoch) = host(&t);
    let first = ok_text(run(
        &reg,
        epoch,
        json!({"title": "D", "mediaType": "text/html", "source": "v1", "artifactId": "a9"}),
    ));
    let second = ok_text(run(
        &reg,
        epoch,
        json!({"title": "D", "mediaType": "text/html", "source": "v2", "artifactId": "a9"}),
    ));
    assert!(
        first.contains('1') && second.contains('2'),
        "{first} / {second}"
    );
    let norm = |p: &PathBuf| p.to_string_lossy().replace('\\', "/");
    let v1 = walk(&t.session)
        .into_iter()
        .find(|p| norm(p).contains("a9-1/source"))
        .expect("v1 kept");
    assert_eq!(
        std::fs::read_to_string(v1).expect("read"),
        "v1",
        "history intact"
    );
}

#[test]
fn bad_media_type_oversize_and_shape_refused() {
    let t = trees();
    let (reg, epoch) = host(&t);
    for bad in [
        json!({"title": "D", "mediaType": "application/pdf", "source": "x"}),
        json!({"title": "", "mediaType": "text/html", "source": "x"}),
        json!({"title": "D", "mediaType": "text/html"}),
        json!({"title": "D", "mediaType": "text/html", "source": "x".repeat(300_000)}),
    ] {
        let out = run(&reg, epoch, bad);
        assert!(matches!(out, ToolOutcome::Error { .. }), "{out:?}");
    }
    let svg = ok_text(run(
        &reg,
        epoch,
        json!({"title": "S", "mediaType": "image/svg+xml", "source": "<svg></svg>"}),
    ));
    assert!(svg.contains('1'));
}
