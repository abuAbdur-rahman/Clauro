//! Task 004 — Windows path rules, living in `clauro-fs` (RED).
//!
//! Order is load-bearing (D34): canonicalise, resolve symlinks and junctions,
//! **then** check traversal — checking first is bypassable. Reserved device
//! names are rejected case-insensitively **and with any extension**: `NUL.txt`
//! is `NUL`. Full set `CON PRN AUX NUL COM1–COM9 LPT1–LPT9` plus superscripts
//! `COM¹²³` / `LPT¹²³` (D79). Budget is `MAX_PATH` from the drive root (D79).

use clauro_fs::{is_reserved_file_name, is_within, resolve_in_workspace, PathError};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn fresh() -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("clauro-fs-004-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).expect("scratch root must be creatable");
        // Canonicalise once: temp dirs on some hosts are themselves symlinked.
        let path = path.canonicalize().expect("scratch root must canonicalise");
        Self { path }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

// ── reserved device names ────────────────────────────────────────────────────

#[test]
fn reserved_names_rejected_with_any_extension_and_case() {
    // Every one of these is the device, not a file.
    for name in [
        "NUL",
        "nul",
        "NUL.txt",
        "nul.TXT",
        "CON",
        "con.jpg",
        "PRN",
        "prn.",
        "AUX",
        "aux.md",
        "COM1",
        "com1",
        "COM9.log",
        "LPT1",
        "lpt9.dat",
        "COM¹",
        "com²",
        "LPT³",
        "lpt¹.txt",
    ] {
        assert!(
            is_reserved_file_name(name),
            "{name} must be recognised as reserved"
        );
        let root = TestRoot::fresh();
        assert!(
            resolve_in_workspace(&root.path, name).is_err(),
            "{name} must not resolve inside the workspace"
        );
    }
}

#[test]
fn near_misses_are_ordinary_files() {
    // A guard that refuses a commit hash gets turned off; same for file names.
    for name in [
        "null.txt",
        "commit",
        "com10",
        "COM10.log",
        "lpt10",
        "auxiliary.md",
        "console.log",
        "my nul file.txt",
        "com1x",
        "xcom1",
    ] {
        assert!(
            !is_reserved_file_name(name),
            "{name} must NOT be treated as reserved"
        );
        let root = TestRoot::fresh();
        assert!(
            resolve_in_workspace(&root.path, name).is_ok(),
            "{name} must resolve normally"
        );
    }
}

// ── traversal order: canonicalise first, check second ────────────────────────

#[test]
fn dotdot_and_encoded_escapes_rejected() {
    let root = TestRoot::fresh();
    for evil in [
        "../outside.txt",
        "..\\outside.txt",
        "a/../../outside.txt",
        "a\\..\\..\\outside.txt",
        "%2e%2e%2foutside.txt",
        "%2E%2E%5Coutside.txt",
        "..%2foutside.txt",
        "a/..\\b.txt",
    ] {
        let err =
            resolve_in_workspace(&root.path, evil).expect_err(&format!("{evil} must not escape"));
        assert!(
            matches!(err, PathError::Traversal | PathError::OutsideTree),
            "{evil} must fail as traversal, got: {err}"
        );
    }
}

#[test]
fn absolute_paths_and_nt_bypasses_rejected() {
    let root = TestRoot::fresh();
    for evil in [
        "/absolute.txt",
        "\\absolute.txt",
        "C:\\windows\\x.txt",
        "D:/data.txt",
        "\\\\server\\share\\x.txt",
        "\\\\?\\C:\\x.txt",
    ] {
        assert!(
            resolve_in_workspace(&root.path, evil).is_err(),
            "{evil} must never resolve"
        );
    }
}

#[test]
fn plain_relative_paths_resolve_under_the_root() {
    let root = TestRoot::fresh();
    let got = resolve_in_workspace(&root.path, "a/b.txt").expect("must resolve");
    assert_eq!(got, root.path.join("a").join("b.txt"));
}

#[test]
fn containment_is_component_wise_not_prefix_text() {
    // `/root-other` starts with `/root` as text but is not inside it.
    let root = PathBuf::from("/tmp/clauro-root");
    assert!(is_within(&root, &root.join("a")));
    assert!(!is_within(&root, &PathBuf::from("/tmp/clauro-root-other")));
    assert!(!is_within(
        &root,
        &PathBuf::from("/tmp/clauro-root-other/a")
    ));
    assert!(!is_within(&root, &PathBuf::from("/tmp/other")));
}

#[test]
fn symlink_pointing_outside_is_rejected_after_resolution() {
    let root = TestRoot::fresh();
    let outside = TestRoot::fresh();
    std::fs::write(outside.path.join("secret.txt"), "x").expect("seed must write");
    let link = root.path.join("link");
    let target = outside.path.join("secret.txt");
    let made = {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(&target, &link)
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(&target, &link)
        }
    };
    if made.is_err() {
        // No privilege to create symlinks on this host (Windows needs
        // Developer Mode). The containment half must still hold on its own:
        // an already-resolved path outside the root never passes.
        assert!(!is_within(&root.path, &target));
        let resolved_outside = target.canonicalize().expect("target must resolve");
        assert!(!is_within(&root.path, &resolved_outside));
        return;
    }
    let err =
        resolve_in_workspace(&root.path, "link").expect_err("a link escaping the tree must fail");
    assert!(
        matches!(err, PathError::OutsideTree),
        "must fail AFTER resolution, got: {err}"
    );
}

// ── budget ───────────────────────────────────────────────────────────────────

#[test]
fn overlong_paths_rejected_from_the_drive_root() {
    let root = TestRoot::fresh();
    let long = "a".repeat(300);
    let err = resolve_in_workspace(&root.path, &long).expect_err("300 chars must fail");
    assert!(
        matches!(err, PathError::TooLong),
        "must fail as TooLong, got: {err}"
    );
}
