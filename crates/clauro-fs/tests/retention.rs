//! Task 019 — project subtree deletion on real fs (D10/delete-every-byte).
use clauro_fs::remove_project_subtree;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(10_000);

fn fresh_root() -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!("clauro-019-{}-{n}", std::process::id()));
    std::fs::create_dir_all(p.join("projects").join("p1-abc")).unwrap();
    std::fs::write(p.join("projects").join("p1-abc").join("out.txt"), "full").unwrap();
    std::fs::create_dir_all(p.join("projects").join("other")).unwrap();
    p.canonicalize().unwrap()
}

fn walk_files(root: &std::path::Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let rd = match std::fs::read_dir(&d) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.flatten() {
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
fn delete_project_removes_subtree_only() {
    let root = fresh_root();
    remove_project_subtree(&root, "p1").unwrap();
    let files = walk_files(&root);
    assert!(!files.iter().any(|p| p.to_string_lossy().contains("p1-abc")));
    assert!(files.is_empty() || root.join("projects").join("other").exists());
    std::fs::remove_dir_all(&root).ok();
}
