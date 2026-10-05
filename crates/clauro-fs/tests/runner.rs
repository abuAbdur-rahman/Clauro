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
    let shown = out.stdout.trim().replace('\\', "/");
    let mut want = dir
        .canonicalize()
        .expect("canon")
        .to_string_lossy()
        .replace('\\', "/");
    // `canonicalize` may return the verbatim `//?/` prefix; `cd` does not.
    want = want.trim_start_matches("//?/").to_string();
    assert_eq!(shown, want, "root-confined cwd");
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
    let pidfile = dir.join("grandchild.pid");
    #[cfg(windows)]
    let script = windows_launcher(&pidfile);
    #[cfg(not(windows))]
    let script = format!("sleep 60 & echo $! > '{}'; wait", pidfile.display());
    let mut child = spawn_command(&script, &dir, &[], &[]).expect("spawn");
    // Wait for the grandchild pid to land (bounded: 100 * 50ms).
    let mut grandchild: Option<String> = None;
    for _ in 0..100 {
        if let Ok(text) = std::fs::read_to_string(&pidfile) {
            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
                grandchild = Some(trimmed);
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let grandchild = grandchild.expect("grandchild pid recorded");
    kill_group(child.pid()).expect("group kill");
    let _ = child.wait();
    assert!(
        !grandchild_alive(&grandchild),
        "grandchild must die with the group"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(windows)]
fn windows_launcher(pidfile: &std::path::Path) -> String {
    // Base64 UTF-16LE for -EncodedCommand: no quote character survives to
    // cmd, so nothing can mangle the nesting. The script starts a grandchild
    // sleeper, records its pid, then sleeps itself to keep the tree alive.
    // NOTE: Out-File without -Encoding writes UTF-16+BOM, which never parses
    // as a pid. Ascii keeps the pidfile machine-readable.
    let ps = format!(
        "$p=Start-Process powershell -ArgumentList '-Command','Start-Sleep 60' -PassThru;$p.Id|Out-File -Encoding ascii '{}';Start-Sleep 60",
        pidfile.display()
    );
    let mut utf16 = Vec::new();
    for c in ps.encode_utf16() {
        utf16.extend_from_slice(&c.to_le_bytes());
    }
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut b64 = String::new();
    for chunk in utf16.chunks(3) {
        let mut n: u32 = 0;
        for (i, &b) in chunk.iter().enumerate() {
            n |= (b as u32) << (8 * (2 - i));
        }
        let pad = 3 - chunk.len();
        for i in 0..4 - pad {
            b64.push(ALPHABET[((n >> (6 * (3 - i))) & 63) as usize] as char);
        }
        for _ in 0..pad {
            b64.push('=');
        }
    }
    format!("powershell -NoProfile -EncodedCommand {b64}")
}

#[cfg(windows)]
fn grandchild_alive(pid: &str) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(pid))
        .unwrap_or(true)
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
