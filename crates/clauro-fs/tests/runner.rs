//! Task 012 — host-owned runner, std only (RED).
//!
//! Process-group kill, credential scrub, staged env merge, null stdin,
//! truncation with spill, cwd pinned to the workspace. Group kill is
//! `taskkill /T /F` on Windows and `process_group` + `kill -- -pgid` on Unix
//! (both present on dev and CI images) — no new dependency for either.

use clauro_fs::runner::{
    build_env, kill_group, run_command, scrub_env_vars, spawn_command, RunLimits,
};
use std::path::PathBuf;

fn tmp() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "clauro-012r-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("scratch");
    dir
}

fn limits() -> RunLimits {
    RunLimits { max_bytes: 4096 }
}

// ── env ──────────────────────────────────────────────────────────────────────

#[test]
fn secret_names_and_values_scrubbed() {
    let vars = vec![
        ("PATH".to_string(), "/bin".to_string()),
        (
            "CLAURO_TEST_API_KEY".to_string(),
            "sk-live-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
        ),
        (
            "MYSTERY".to_string(),
            "github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
        ),
        ("NORMAL".to_string(), "hello".to_string()),
    ];
    let scrubbed = scrub_env_vars(&vars);
    assert!(scrubbed.iter().any(|(k, _)| k == "PATH"));
    assert!(scrubbed.iter().any(|(k, _)| k == "NORMAL"));
    assert!(
        !scrubbed.iter().any(|(k, _)| k == "CLAURO_TEST_API_KEY"),
        "{scrubbed:?}"
    );
    assert!(
        !scrubbed.iter().any(|(k, _)| k == "MYSTERY"),
        "{scrubbed:?}"
    );
}

#[test]
fn merge_order_is_scrub_overrides_env_managed() {
    let base = vec![("A".to_string(), "base".to_string())];
    let merged = build_env(
        &base,
        &[("A".to_string(), "override".to_string())],
        &[
            ("A".to_string(), "ordinary".to_string()),
            ("B".to_string(), "b".to_string()),
        ],
        &[("A".to_string(), "managed".to_string())],
    );
    let get = |k: &str| {
        merged
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
    };
    assert_eq!(
        get("A").as_deref(),
        Some("managed"),
        "managed always wins (D30)"
    );
    assert_eq!(get("B").as_deref(), Some("b"));
}

// ── execution ────────────────────────────────────────────────────────────────

#[test]
fn child_runs_with_workspace_cwd_and_null_stdin() {
    let dir = tmp();
    #[cfg(windows)]
    let out = run_command("cd", &dir, &[], &[], limits()).expect("run");
    #[cfg(not(windows))]
    let out = run_command("pwd", &dir, &[], &[], limits()).expect("run");
    assert_eq!(out.exit_code, 0);
    // Both sides canonicalized: `cd` may print an 8.3 short name
    // (`RUNNER~1`) where `canonicalize` resolves the long one
    // (`runneradmin`), depending on the drive's short-name setting. Comparing
    // raw strings makes the test a referendum on the runner's filesystem, not
    // on root confinement. This exact shape failed Windows CI while local
    // stayed green.
    let shown_canon = std::path::PathBuf::from(out.stdout.trim())
        .canonicalize()
        .expect("shown cwd resolves")
        .to_string_lossy()
        .replace('\\', "/");
    let shown_canon = shown_canon.trim_start_matches("//?/").to_string();
    let mut want = dir
        .canonicalize()
        .expect("canon")
        .to_string_lossy()
        .replace('\\', "/");
    // `canonicalize` may return the verbatim `//?/` prefix; `cd` does not.
    want = want.trim_start_matches("//?/").to_string();
    assert_eq!(shown_canon, want, "root-confined cwd");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stdin_closed_so_readers_exit() {
    let dir = tmp();
    #[cfg(windows)]
    let out = run_command("sort", &dir, &[], &[], limits()).expect("run");
    #[cfg(not(windows))]
    let out = run_command("cat", &dir, &[], &[], limits()).expect("run");
    assert_eq!(out.exit_code, 0, "EOF on fd0, no hang");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn output_truncates_with_spill_kept() {
    let dir = tmp();
    let limits = RunLimits { max_bytes: 1000 };
    #[cfg(windows)]
    let cmd = "for /L %i in (1,1,500) do @echo output-line-%i-padding-padding";
    #[cfg(not(windows))]
    let cmd = "seq 1 500";
    let out = run_command(cmd, &dir, &[], &[], limits).expect("run");
    assert!(out.truncated, "over cap must flag");
    let spill = out.spill_path.expect("spill kept");
    let kept = std::fs::read_to_string(&spill).expect("spill reads");
    assert!(kept.len() > 1000, "full output on disk: {}", kept.len());
    assert!(out.stdout.len() <= 1000 + 64);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn killing_kills_the_group_not_just_the_shell() {
    let dir = tmp();
    // Image-name detection is only sound if the host has no stray of that
    // image. Asserted before the spawn, with the reason named.
    #[cfg(windows)]
    assert_eq!(
        tasklist_count("ping.exe"),
        0,
        "a ping.exe already running on this host would make this test's \
         image-name detection unsound; re-run once none is running"
    );
    #[cfg(not(windows))]
    let pidfile = dir.join("grandchild.pid");
    #[cfg(windows)]
    let script = windows_launcher();
    #[cfg(not(windows))]
    let script = format!("sleep 60 & echo $! > '{}'; wait", pidfile.display());
    let mut child = spawn_command(&script, &dir, &[], &[]).expect("spawn");
    // Descendants must be up before the kill, or the assertion is vacuous.
    #[cfg(windows)]
    {
        assert!(
            wait_for(30, group_alive),
            "grandchildren must be running before the group kill"
        );
        kill_group(child.pid()).expect("group kill");
        let _ = child.wait();
        assert!(
            wait_for(15, || !group_alive()),
            "grandchildren must die with the group, not outlive it"
        );
    }
    #[cfg(not(windows))]
    {
        let grandchild = wait_for_pid(&pidfile);
        assert!(
            grandchild_alive(&grandchild),
            "grandchild must be running before the group kill"
        );
        kill_group(child.pid()).expect("group kill");
        let _ = child.wait();
        assert!(
            wait_for(15, || !grandchild_alive(&grandchild)),
            "grandchild must die with the group, not outlive it"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Poll `check` until it holds, or the budget in tenths of a second expires.
fn wait_for(tenths: u32, mut check: impl FnMut() -> bool) -> bool {
    for _ in 0..tenths {
        if check() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    check()
}

#[cfg(windows)]
fn windows_launcher() -> String {
    // Two generations below the tracked shell, and no PowerShell anywhere.
    // An earlier draft recorded the grandchild's pid through
    // `Start-Process ... | Out-File`, which made the test depend on
    // PowerShell's first-use module initialisation — seconds of it under a
    // parallel `cargo test --workspace`, and once past a 30s budget the test
    // failed on the host's PowerShell, not on the group kill.
    //
    // `start /B` runs the grandchild without a window and without waiting, so
    // the launcher stays alive as its parent while the grandchildren live.
    // They are identified by image name instead of by pid, which is sound
    // because `tasklist_count` is asserted to be zero before the spawn: any
    // ping.exe seen afterwards belongs to this tree.
    "start /B ping -n 61 127.0.0.1 >NUL & ping -n 61 127.0.0.1 >NUL".to_string()
}

#[cfg(windows)]
fn group_alive() -> bool {
    tasklist_count("ping.exe") > 0
}

#[cfg(windows)]
fn tasklist_count(image: &str) -> usize {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| l.to_ascii_lowercase().contains(&image.to_ascii_lowercase()))
                .count()
        })
        .unwrap_or(0)
}

#[cfg(not(windows))]
fn wait_for_pid(pidfile: &std::path::Path) -> String {
    wait_for(300, || {
        std::fs::read_to_string(pidfile)
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()))
            .is_some()
    })
    // Trim again on the way out: `echo` leaves a trailing newline, and an
    // untrimmed pid makes `kill -0` fail — which reads as "grandchild dead"
    // when the grandchild is fine. This exact shape failed Linux CI while
    // Windows stayed green, because only this path reads pids from a file.
    .then(|| {
        std::fs::read_to_string(pidfile)
            .expect("pid recorded")
            .trim()
            .to_string()
    })
    .expect("grandchild pid recorded")
}

#[cfg(not(windows))]
fn grandchild_alive(pid: &str) -> bool {
    // `kill -0` probes without signalling; zombie-or-gone both read dead
    // here because the group kill took the parent shell too.
    std::process::Command::new("kill")
        .args(["-0", pid])
        .status()
        .map(|s| s.success())
        .unwrap_or(true)
        && !is_zombie(pid)
}

#[cfg(not(windows))]
fn is_zombie(pid: &str) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|s| s.split_whitespace().nth(2) == Some("Z"))
        .unwrap_or(true)
}
