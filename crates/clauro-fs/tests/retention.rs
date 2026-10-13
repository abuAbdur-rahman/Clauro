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

/// Unprivileged link: junction (`mklink /J`) on Windows, `symlink` on unix.
fn make_dir_link(link: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other("mklink /J failed"))
        }
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link)
    }
}

fn outside_dir(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "clauro-019-out-{tag}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&p).expect("outside dir");
    p
}

#[test]
fn junction_project_entry_is_removed_as_a_link_never_followed() {
    // audit 11: a junction planted at `projects/p1-*` pointing OUTSIDE the
    // tree. Canonicalised containment catches it — but the old code then
    // returned `Err(OutsideTree)`, aborting the whole retention run (a
    // planted link = DoS of deletion), and a sibling real dir sharing the id
    // prefix went un-deleted. Correct behaviour: remove the LINK node itself
    // (never its target), keep going, finish the run.
    let root = fresh_root();
    let outside = outside_dir("jn");
    std::fs::write(outside.join("precious.txt"), "outside").expect("seed");
    make_dir_link(&root.join("projects").join("p1-jn"), &outside)
        .expect("unprivileged junction/symlink must be creatable");
    remove_project_subtree(&root, "p1").expect("a planted link must not abort the run");
    assert!(
        outside.join("precious.txt").exists(),
        "the link target is never touched"
    );
    assert!(
        root.join("projects")
            .join("p1-jn")
            .symlink_metadata()
            .is_err(),
        "the link node itself is gone"
    );
    assert!(
        !root.join("projects").join("p1-abc").exists(),
        "the real sibling subtree is deleted in the same run"
    );
    assert!(
        root.join("projects").join("other").exists(),
        "unrelated entries untouched"
    );
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn dangling_link_entry_is_removed_not_completed_lexically() {
    // audit 11: `canonicalize().unwrap_or(p.clone())` let an unresolvable
    // (dangling) entry reach `is_within` as its own LEXICAL path — which
    // passes trivially — exactly what the `is_within` doc forbids. Refuse
    // the lexical fallback: an entry that cannot resolve is handled as a
    // link node (removed), or, if it simply vanished mid-iteration, skipped.
    let root = fresh_root();
    let outside = outside_dir("dang");
    make_dir_link(&root.join("projects").join("p1-dang"), &outside)
        .expect("unprivileged junction/symlink must be creatable");
    std::fs::remove_dir_all(&outside).expect("target removed — the link now dangles");
    remove_project_subtree(&root, "p1").expect("a dangling entry must not abort the run");
    assert!(
        root.join("projects")
            .join("p1-dang")
            .symlink_metadata()
            .is_err(),
        "the dangling link node is gone, not left behind"
    );
    assert!(
        !root.join("projects").join("p1-abc").exists(),
        "the real sibling subtree is deleted in the same run"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn project_id_edges_are_typed_refusals_changing_nothing() {
    // audit 11 NIT: validation was weaker than `check_relative_path` —
    // reserved names, `..`-with-trailing-space, drive/stream forms and
    // percent-encoded traversal all slipped through to a silent no-op
    // (`p1.` deletes nothing, reports nothing).
    let root = fresh_root();
    for bad in [
        "",
        "..",
        "a/b",
        "a\\b",
        "..\\x",
        "p1/../p2",
        "NUL",
        "nul.txt",
        "con",
        "p1.",
        "p1 ",
        "%2e%2e",
        "C:",
        "a:b",
        "p1:hidden",
    ] {
        let msg = format!("{bad:?} must be a typed refusal");
        let err = remove_project_subtree(&root, bad).expect_err(&msg);
        assert!(
            !err.to_string().is_empty(),
            "typed error must describe itself"
        );
    }
    assert!(
        root.join("projects").join("p1-abc").exists(),
        "every refusal changed nothing"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn sibling_prefix_collisions_untouched() {
    // `p10-x` and `p100` share a STRING prefix with `p1` but not the `p1-`
    // boundary; only exact `p1` or `p1-*` may go.
    let root = fresh_root();
    for sib in ["p10-x", "p100", "other"] {
        std::fs::create_dir_all(root.join("projects").join(sib)).expect("sibling");
        std::fs::write(root.join("projects").join(sib).join("keep.txt"), "k").expect("seed");
    }
    remove_project_subtree(&root, "p1").unwrap();
    assert!(!root.join("projects").join("p1-abc").exists());
    for kept in ["p10-x", "p100", "other"] {
        assert!(
            root.join("projects").join(kept).join("keep.txt").exists(),
            "{kept} must survive a p1 deletion"
        );
    }
    std::fs::remove_dir_all(&root).ok();
}
