//! Task 004 — Windows path rules, living in `clauro-fs` (RED).
//!
//! Order is load-bearing (D34): canonicalise, resolve symlinks and junctions,
//! **then** check traversal — checking first is bypassable. Reserved device
//! names are rejected case-insensitively **and with any extension**: `NUL.txt`
//! is `NUL`. Full set `CON PRN AUX NUL COM1–COM9 LPT1–LPT9` plus superscripts
//! `COM¹²³` / `LPT¹²³` (D79). Budget is `MAX_PATH` from the drive root (D79).

use clauro_fs::{is_reserved_file_name, is_within, resolve_in_workspace, PathError};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Create a link that points `link` → `target`. On Windows this is a
/// JUNCTION via `mklink /J`, which is **unprivileged** (unlike
/// `symlink_file`, which needs Developer Mode / SeCreateSymbolicLinkPrivilege
/// — the common-case host has neither). Junctions must exist (audit 40/11:
/// the old privileged-symlink attempt degraded to a tautology and the real
/// `OutsideTree` branch silently stopped running; a link that cannot be
/// created is now a TEST FAILURE, never an early return).
fn make_dir_link(link: &Path, target: &Path) -> std::io::Result<()> {
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
        let msg = format!("{evil} must not escape");
        let err = resolve_in_workspace(&root.path, evil).expect_err(&msg);
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
fn link_escaping_the_tree_is_rejected_after_resolution() {
    // audit 40 CRITICAL / 01 tier-7 / 11: the flagship escape test used a
    // PRIVILEGED file symlink and, when that failed (Windows without
    // Developer Mode — the common case), returned early asserting a
    // tautology over two unrelated temp dirs. A junction is unprivileged, so
    // the real assertion always runs, and link creation failing fails the
    // test instead of green-lighting nothing.
    let root = TestRoot::fresh();
    let outside = TestRoot::fresh();
    std::fs::write(outside.path.join("secret.txt"), "x").expect("seed must write");
    make_dir_link(&root.path.join("link"), &outside.path)
        .expect("unprivileged junction/symlink must be creatable — the real branch must run");
    let err =
        resolve_in_workspace(&root.path, "link").expect_err("a link escaping the tree must fail");
    assert!(
        matches!(err, PathError::OutsideTree),
        "must fail AFTER resolution, got: {err}"
    );
    // Same with a tail past the link: `link/secret.txt` still resolves out.
    let err = resolve_in_workspace(&root.path, "link/secret.txt")
        .expect_err("a tail through an escaping link must fail");
    assert!(
        matches!(err, PathError::OutsideTree),
        "must fail AFTER resolution, got: {err}"
    );
}

#[test]
fn dangling_link_tail_is_refused_not_completed_lexically() {
    // audit 11: a DANGLING link's `exists()` is false, so the tail walk used
    // to step past it and rebuild `root/link/file` lexically — passing
    // containment. A later write/read then followed the link if it ever
    // retargeted (escape + retarget race). Refuse instead: a link entry that
    // does not resolve never reaches `is_within`.
    let root = TestRoot::fresh();
    let outside = TestRoot::fresh();
    make_dir_link(&root.path.join("link"), &outside.path)
        .expect("unprivileged junction/symlink must be creatable");
    std::fs::remove_dir_all(&outside.path).expect("target removed — the link now dangles");
    let err = resolve_in_workspace(&root.path, "link/file.txt")
        .expect_err("a dangling link tail must not complete lexically");
    assert!(
        matches!(err, PathError::Unresolvable(_)),
        "must fail as an unresolvable link, got: {err}"
    );
}

// ── lexical vectors the containment check cannot see (audit 11) ─────────────

#[test]
fn drive_relative_and_stream_components_rejected() {
    let root = TestRoot::fresh();
    for evil in [
        // Mid-string `C:` gives the joined path a Windows prefix and std
        // `join` DISCARDS the root → drive-relative against process cwd.
        "a/C:/b",
        "docs/sub/D:evil.txt",
        // NTFS alternate data streams: bytes land in an invisible stream,
        // bypassing every name-based rule (`report.txt:hidden`), including
        // the reserved check (`NUL:stream` — device + stream, no dot).
        "report.txt:hidden",
        "NUL:stream",
        "a/b.txt:ads:$DATA",
    ] {
        let msg = format!("{evil} must not resolve");
        let err = resolve_in_workspace(&root.path, evil).expect_err(&msg);
        assert!(
            matches!(
                err,
                PathError::Invalid(_) | PathError::ReservedName(_) | PathError::Absolute
            ),
            "{evil} must fail as invalid/reserved/absolute, got: {err}"
        );
    }
    // The reserved check itself sees through the stream suffix.
    assert!(is_reserved_file_name("NUL:stream"));
    assert!(is_reserved_file_name("con:stream"));
    assert!(!is_reserved_file_name("report.txt:hidden"));
}

#[test]
fn nul_bytes_rejected_after_decoding() {
    let root = TestRoot::fresh();
    for evil in ["%00evil.txt", "a%00b", "dir/%00"] {
        let msg = format!("{evil} must not resolve");
        let err = resolve_in_workspace(&root.path, evil).expect_err(&msg);
        assert!(
            matches!(err, PathError::Invalid(_)),
            "{evil} must fail as invalid, got: {err}"
        );
    }
}

#[test]
fn dotdot_with_trailing_space_or_dot_is_still_traversal() {
    // Windows trims trailing spaces/dots per component during path
    // normalisation, so `.. ` IS `..` on the host — a lexical check on the
    // raw form let it through and the OS resolved it as traversal.
    let root = TestRoot::fresh();
    for evil in [".. /x.txt", "a/.. /b.txt", ".. ", ".. .", "a/.."] {
        let msg = format!("{evil:?} must not resolve");
        let err = resolve_in_workspace(&root.path, evil).expect_err(&msg);
        assert!(
            matches!(err, PathError::Traversal),
            "{evil:?} must fail as traversal, got: {err}"
        );
    }
}

#[test]
fn trailing_dot_component_stays_contained_never_collides_silently() {
    // `file.txt.` and `file.txt` are the same file to PLAIN Win32 paths —
    // but `resolve_in_workspace` hands back `\\?\`-rooted paths (the root is
    // canonicalised), and the extended namespace DISABLES trailing-dot
    // stripping: the literal `file.txt.` is a distinct name. Pin the
    // security property (containment either way) and the no-silent-collapse
    // behaviour, so a future change cannot reintroduce the collision.
    let root = TestRoot::fresh();
    std::fs::write(root.path.join("file.txt"), "x").expect("seed");
    let got = resolve_in_workspace(&root.path, "file.txt.").expect("must resolve");
    let want = resolve_in_workspace(&root.path, "file.txt").expect("must resolve");
    assert!(is_within(&root.path, &got), "stays inside the root");
    assert!(
        got == want || got.ends_with("file.txt."),
        "either normalised to the same file or kept literal, got: {:?}",
        got.display()
    );
}

#[test]
fn near_misses_stay_inside_the_root() {
    // 8.3 short names and fullwidth homoglyphs are ordinary components:
    // never reserved, never silently remapped, and containment holds (8.3
    // expands under `canonicalise`, so a short name cannot smuggle an
    // escape; fullwidth `ＮＵＬ` is not the `NUL` device).
    let root = TestRoot::fresh();
    assert!(!is_reserved_file_name("NUL~1"));
    assert!(!is_reserved_file_name("ＮＵＬ"));
    assert!(!is_reserved_file_name("ＣＯＮ"));
    for ordinary in ["NUL~1/file.txt", "ＲＥＳＵＭＥ~1", "ｎｕｌ.txt", "CON¹~1"] {
        let got = resolve_in_workspace(&root.path, ordinary)
            .unwrap_or_else(|e| panic!("{ordinary} must resolve: {e}"));
        assert!(is_within(&root.path, &got), "{ordinary} stays inside");
    }
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

#[test]
fn budget_counts_utf16_units_not_scalars() {
    // Windows budgets MAX_PATH in UTF-16 code units (D79), not Unicode
    // scalars: one emoji is one scalar but TWO units, so the unit count —
    // not the scalar count — decides TooLong.
    let root = TestRoot::fresh();
    // Margins chosen so the verdict depends on the UTF-16 count, never on
    // the scratch root's own length (50·2+root ≪ 260 ≤ 150·2+root).
    let ok = "😀".repeat(50); // 100 UTF-16 units, 50 scalars
    let got = resolve_in_workspace(&root.path, &ok).expect("100 units must resolve");
    assert!(is_within(&root.path, &got));
    let over = "😀".repeat(150); // 300 UTF-16 units — at the budget
    let err = resolve_in_workspace(&root.path, &over).expect_err("300 units must fail");
    assert!(
        matches!(err, PathError::TooLong),
        "must fail as TooLong, got: {err}"
    );
}
