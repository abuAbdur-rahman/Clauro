//! Task 010 — `fs` rooted at a Clauro-owned tree (RED).
//!
//! Read-before-edit is host state (D33): `edit` without a prior `read` of the
//! same path this session fails and changes nothing. Reads span the session
//! workspace and the project dir; writes stay inside the session workspace.
//! Uploads copy in (never reference), dedupe per project, model sees
//! metadata only (D47/D52). Reserved upload names rename, not reject (D79).

use clauro_core::{ToolContext, ToolOutcome};
use clauro_store::Store;
use clauro_tools::{register_fs, FsHost, IncomingCall, Registry};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Trees {
    // Store FIRST: dropped first, so the SQLite connection closes before
    // the directory is removed. Windows cannot delete open files, and a
    // surviving dir means the next run reopens a dirty database.
    store: Arc<Mutex<Store>>,
    tmp: PathBuf,
    session: PathBuf,
    project: PathBuf,
}

fn trees() -> Trees {
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    // Fresh by construction: pid + counter + nanos, and never reuse an
    // existing dir — Windows reuses pids, and a crashed run's litter must not
    // seed a dirty database.
    let mut stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = loop {
        let candidate =
            std::env::temp_dir().join(format!("clauro-010-{}-{n}-{stamp}", std::process::id()));
        if std::fs::create_dir(&candidate).is_ok() {
            break candidate;
        }
        stamp += 1;
    };
    let session = tmp.join("sessions").join("s1-title");
    let project = tmp.join("projects").join("p1-proj");
    std::fs::create_dir_all(&session).expect("session dir");
    std::fs::create_dir_all(&project).expect("project dir");
    let inner = Store::open(&tmp.join("test.db")).expect("db");
    for pid in ["p1", "pa", "pb"] {
        inner
            .insert_project(clauro_store::NewProject {
                id: pid.to_string(),
                name: pid.to_string(),
                instructions: String::new(),
                bash_enabled: false,
            })
            .expect("project");
    }
    let store = Arc::new(Mutex::new(inner));
    Trees {
        store,
        tmp,
        session,
        project,
    }
}

impl Drop for Trees {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.tmp) {
            eprintln!("TREES_DROP_FAILED {:?}: {e}", self.tmp);
        }
    }
}

fn host(t: &Trees, project_id: Option<&str>) -> (Registry, Arc<FsHost>, u64) {
    let h = Arc::new(
        FsHost::new(
            &t.session,
            &t.project,
            project_id.map(str::to_string),
            t.store.clone(),
        )
        .expect("host"),
    );
    let mut reg = Registry::with_eight();
    register_fs(&mut reg, h.clone());
    let epoch = reg.materialize().epoch;
    (reg, h, epoch)
}

fn ctx() -> ToolContext {
    ToolContext {
        thread_id: "t1".to_string(),
        call_id: "c1".to_string(),
        workspace_dir: PathBuf::from("/unused"),
    }
}

fn run(reg: &Registry, epoch: u64, input: serde_json::Value) -> ToolOutcome {
    reg.dispatch(
        &IncomingCall {
            name: "fs".to_string(),
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

fn err_text(out: ToolOutcome) -> String {
    match out {
        ToolOutcome::Error { message } => message,
        other => panic!("expected error, got: {other:?}"),
    }
}

// ── read-before-edit ─────────────────────────────────────────────────────────

#[test]
fn edit_without_read_fails_and_changes_nothing() {
    let t = trees();
    std::fs::write(t.session.join("a.txt"), "hello").expect("seed");
    let (reg, _, epoch) = host(&t, None);
    let err = err_text(run(
        &reg,
        epoch,
        json!({"command": "edit", "path": "a.txt", "old_string": "hello", "new_string": "bye"}),
    ));
    assert!(!err.is_empty());
    assert_eq!(
        std::fs::read_to_string(t.session.join("a.txt")).expect("read"),
        "hello"
    );
}

#[test]
fn edit_after_read_succeeds_unique_match_required() {
    let t = trees();
    std::fs::write(t.session.join("a.txt"), "hello hello").expect("seed");
    let (reg, _, epoch) = host(&t, None);
    let _ = ok_text(run(
        &reg,
        epoch,
        json!({"command": "read", "path": "a.txt"}),
    ));
    let ambiguous = run(
        &reg,
        epoch,
        json!({"command": "edit", "path": "a.txt", "old_string": "hello", "new_string": "bye"}),
    );
    assert!(
        matches!(ambiguous, ToolOutcome::Error { .. }),
        "two matches, no replace_all"
    );
    let out = ok_text(run(
        &reg,
        epoch,
        json!({"command": "edit", "path": "a.txt", "old_string": "hello", "new_string": "bye", "replace_all": true}),
    ));
    assert!(out.contains('2'), "reports the count: {out}");
    assert_eq!(
        std::fs::read_to_string(t.session.join("a.txt")).expect("read"),
        "bye bye"
    );
}

// ── roots ────────────────────────────────────────────────────────────────────

#[test]
fn project_readable_session_only_writable() {
    let t = trees();
    std::fs::write(t.project.join("notes.md"), "# notes").expect("seed");
    let (reg, _, epoch) = host(&t, None);
    let read = ok_text(run(
        &reg,
        epoch,
        json!({"command": "read", "path": "notes.md", "scope": "project"}),
    ));
    assert!(read.contains("notes"));
    let denied = run(
        &reg,
        epoch,
        json!({"command": "write", "path": "notes.md", "content": "x", "scope": "project"}),
    );
    assert!(
        matches!(denied, ToolOutcome::Error { .. }),
        "project is read-only"
    );
    let outside = run(
        &reg,
        epoch,
        json!({"command": "write", "path": "../evil.txt", "content": "x"}),
    );
    assert!(matches!(outside, ToolOutcome::Error { .. }));
}

#[test]
fn traversal_symlink_and_reserved_all_refused() {
    let t = trees();
    let (reg, _, epoch) = host(&t, None);
    for evil in [
        "../x.txt",
        "..\\x.txt",
        "%2e%2e%2f/x.txt",
        "NUL.txt",
        "com1",
        "COM¹.log",
    ] {
        let out = run(&reg, epoch, json!({"command": "read", "path": evil}));
        assert!(matches!(out, ToolOutcome::Error { .. }), "{evil} must fail");
    }
    // Symlink inside pointing outside: refused after resolution (D34).
    let outside = t.tmp.join("outside.txt");
    std::fs::write(&outside, "secret").expect("seed");
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(&outside, t.session.join("link.txt"));
    #[cfg(not(windows))]
    let made = std::os::unix::fs::symlink(&outside, t.session.join("link.txt"));
    if made.is_ok() {
        let out = run(&reg, epoch, json!({"command": "read", "path": "link.txt"}));
        assert!(
            matches!(out, ToolOutcome::Error { .. }),
            "link escape refused"
        );
    }
}

// ── uploads ──────────────────────────────────────────────────────────────────

#[test]
fn ingest_copies_never_references() {
    let t = trees();
    let src = t.tmp.join("orig.bin");
    std::fs::write(&src, vec![0u8, 1, 2, 3]).expect("seed");
    let (_, h, _) = host(&t, Some("p1"));
    let meta = h.ingest_local_file(&src, "orig.bin").expect("ingest");
    assert!(src.exists(), "original untouched");
    assert!(
        t.session.join(&meta.path).exists(),
        "copy lives in workspace"
    );
    assert_eq!(meta.size, 4);
    assert!(!meta.media_type.is_empty());
}

#[test]
fn dedupe_scopes_to_the_project() {
    let t = trees();
    let src = t.tmp.join("f.png");
    std::fs::write(&src, b"bytes").expect("seed");
    let (_, ha, _) = host(&t, Some("pa"));
    let (_, hb, _) = host(&t, Some("pb"));
    let first = ha.ingest_local_file(&src, "f.png").expect("ingest");
    let again = ha.ingest_local_file(&src, "f.png").expect("ingest");
    assert_eq!(first.path, again.path, "same project: one copy (D52)");
    let pa_files: Vec<_> = std::fs::read_dir(t.session.join("attachments").join("pa"))
        .expect("list")
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(pa_files.len(), 1, "no duplicate file written");
    let other = hb.ingest_local_file(&src, "f.png").expect("ingest");
    assert_ne!(first.path, other.path, "other project: own copy (D52)");
    assert!(t.session.join(&other.path).exists());
}

#[test]
fn reserved_upload_name_renames_not_rejects() {
    let t = trees();
    // The source lives under an ordinary name; the *upload* name is the
    // reserved one (e.g. a file from another OS). It must work, renamed.
    let src = t.tmp.join("upload.txt");
    std::fs::write(&src, "user file").expect("seed");
    let (_, h, _) = host(&t, Some("p1"));
    let meta = h
        .ingest_local_file(&src, "NUL.txt")
        .expect("must work (D79)");
    assert_eq!(
        meta.name, "_NUL.txt",
        "renamed, not rejected: {}",
        meta.path
    );
    assert!(t.session.join(&meta.path).exists());
}

// ── staging, serving, dirs ───────────────────────────────────────────────────

#[test]
fn write_leaves_no_temp_files_behind() {
    let t = trees();
    let (reg, _, epoch) = host(&t, None);
    let _ = ok_text(run(
        &reg,
        epoch,
        json!({"command": "write", "path": "sub/b.txt", "content": "data"}),
    ));
    assert_eq!(
        std::fs::read_to_string(t.session.join("sub").join("b.txt")).expect("read"),
        "data"
    );
    let leftovers: Vec<_> = std::fs::read_dir(t.session.join("sub"))
        .expect("list")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp") || n.starts_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "staging cleaned up: {leftovers:?}");
}

#[test]
fn serve_metadata_table() {
    use clauro_tools::{serve_metadata, Disposition};
    let html = serve_metadata("page.html");
    assert_eq!(html.disposition, Disposition::Attachment);
    assert!(html.nosniff);
    let png = serve_metadata("photo.png");
    assert_eq!(png.disposition, Disposition::Inline);
    assert!(!png.nosniff);
    let svg = serve_metadata("icon.svg");
    assert_eq!(svg.disposition, Disposition::Attachment, "scriptable image");
    assert!(svg.nosniff);
    assert!(serve_metadata("notes.txt").content_type.contains("text"));
}

#[test]
fn session_dirs_keyed_by_id_survive_retitle() {
    use clauro_tools::session_dir;
    let root = Path::new("/data/sessions");
    let created = session_dir(root, "s9", "My First Title!!");
    let name = created.file_name().expect("name").to_string_lossy();
    assert!(name.starts_with("s9-"), "{name}");
    assert!(name.len() <= "s9-".len() + 32, "slug capped: {name}");
}

#[test]
fn lookup_by_id_ignores_the_slug() {
    use clauro_tools::{find_session_dir, session_dir};
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = loop {
        let candidate =
            std::env::temp_dir().join(format!("clauro-010dir-{}-{n}-{stamp}", std::process::id()));
        if std::fs::create_dir(&candidate).is_ok() {
            break candidate;
        }
        stamp += 1;
    };
    // Created under the first title; the thread is retitled afterwards and
    // nothing on disk moves (D32).
    let created = session_dir(&root, "s9", "My First Title!!");
    std::fs::create_dir_all(&created).expect("session dir");
    std::fs::write(created.join("a.txt"), "kept").expect("seed");
    let found = find_session_dir(&root, "s9").expect("lookup by id");
    assert_eq!(found, created);
    assert_eq!(
        std::fs::read_to_string(found.join("a.txt")).expect("read"),
        "kept"
    );
    let _ = std::fs::remove_dir_all(&root);
}
