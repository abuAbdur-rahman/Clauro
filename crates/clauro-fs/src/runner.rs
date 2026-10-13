//! Host-owned command runner (D28–D30, task 012).
//!
//! One runner, one direct-signal dependency: process-group kill is
//! `taskkill /T /F` on Windows and a `process_group` plus kernel SIGKILL
//! via `libc` (**D131**) on Unix — the external `kill(1)` was dropped
//! after its probe lied in CI. Output truncates with spill to disk, fd0 is
//! `/dev/null`, and the child environment is scrubbed then merged in the
//! fixed order `scrub → overrides → env → managed` (D30).
//!
//! Not sandboxed: no container, no namespace, no seccomp. Scrubbed, killed,
//! confined to the working directory — not contained. The UI must say so.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// Truncation cap for captured output, in bytes.
pub const RUN_DEFAULT_MAX_BYTES: usize = 256 * 1024;

/// Default wall-clock budget for one run. Generous enough for a cold build,
/// finite so a hung command cannot wedge the serial turn loop (audit 10).
pub const RUN_DEFAULT_TIMEOUT_MS: u64 = 10 * 60 * 1000;

/// What a run produced. Over-cap output sets `truncated` and keeps everything
/// at `spill_path`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub spill_path: Option<PathBuf>,
}

/// Why a run failed. Execution failures, typed — a non-zero exit is *not* a
/// failure (D55), it is an `Ok` output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    Spawn(String),
    Io(String),
    Killed(String),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(m) => write!(f, "spawn failed: {m}"),
            Self::Io(m) => write!(f, "run failed: {m}"),
            Self::Killed(m) => write!(f, "kill failed: {m}"),
        }
    }
}

impl std::error::Error for RunError {}

/// Truncation + spill limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunLimits {
    pub max_bytes: usize,
    /// Wall-clock budget for the whole run. On expiry the group is killed
    /// and the run returns [`RunError::Killed`] — one hung command must
    /// never wedge the serial turn loop (audit 10).
    pub timeout_ms: u64,
}

/// Variable names that never reach the child, matched case-insensitively on
/// substring: keys, secrets, tokens, passwords, credentials, private matter —
/// plus the audit-11 name gaps `AUTH`, `BEARER`, `DSN`, `COOKIE`, `SESSION`.
/// Over-matching is deliberate: dropping a benign name degrades the child,
/// keeping a credential defeats D29.
fn secret_name(name: &str) -> bool {
    let upper = name.to_uppercase();
    [
        "KEY",
        "SECRET",
        "TOKEN",
        "PASSWD",
        "PASSWORD",
        "CREDENTIAL",
        "PRIVATE",
        "AUTH",
        "BEARER",
        "DSN",
        "COOKIE",
        "SESSION",
    ]
    .iter()
    .any(|frag| upper.contains(frag))
}

/// Credential scrub on the child environment (D29): secret-named variables
/// go, and so does any value shaped like a live secret. Reuses the same
/// shape judgement as the `memory`/`question` guards.
pub fn scrub_env_vars(vars: &[(String, String)]) -> Vec<(String, String)> {
    vars.iter()
        .filter(|(k, v)| !secret_name(k) && !looks_secret_value(v))
        .cloned()
        .collect()
}

/// A live-secret-shaped value: key prefixes and long high-entropy runs.
/// Same shapes as `clauro_tools::looks_secret`, dependency-free (this crate
/// cannot import the tools crate — the graph points the other way).
fn looks_secret_value(v: &str) -> bool {
    // Prefixes compared case-insensitively: `Akia…` and `GHP_…` are real
    // casings a raw `contains("AKIA")`/`contains("ghp_")` never matched
    // (audit 11).
    let upper = v.to_uppercase();
    for prefix in [
        "SK-",
        "GHP_",
        "GITHUB_PAT_",
        "XOXB-",
        "XOXP-",
        "XOXA-",
        "XOXR-",
        "XOXS-",
        "AKIA",
    ] {
        if upper.contains(prefix) {
            return true;
        }
    }
    // URL credentials — `DATABASE_URL=postgres://user:pass@host/db` has no
    // key prefix and no 32-byte entropy run, yet hands a live secret to the
    // child (audit 11's headline example). `scheme://userinfo@host/...` is
    // the shape.
    if url_has_userinfo(v) {
        return true;
    }
    // Long spaceless runs with mixed classes: tokens, not prose.
    for run in v.split(|c: char| c.is_whitespace() || "=:;\"'".contains(c)) {
        if run.len() >= 32
            && run.bytes().any(|b| b.is_ascii_lowercase())
            && run
                .bytes()
                .any(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            && run
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=_-.".contains(&b))
        {
            return true;
        }
    }
    false
}

/// True iff `v` contains `scheme://userinfo@host…` — credentials embedded in
/// a URL. The authority ends at `/`, `?`, `#`, or the end of the string, so
/// an `@` in the path (`https://example.com/a@b`) does not count.
fn url_has_userinfo(v: &str) -> bool {
    let Some(scheme) = v.find("://") else {
        return false;
    };
    let rest = &v[scheme + 3..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    rest[..authority_end].contains('@')
}

/// Fixed merge order (D30): scrubbed process env → internal overrides →
/// ordinary env → managed. Managed always wins; a model-supplied entry can
/// never displace it.
///
/// The slot key is case-insensitive on Windows (audit 11 NIT): env names are
/// there, so a model-supplied `PATH` and a managed `Path` are the *same*
/// slot — otherwise both survive the merge and "managed always wins" becomes
/// a casing coincidence.
pub fn build_env(
    scrubbed_base: &[(String, String)],
    overrides: &[(String, String)],
    ordinary: &[(String, String)],
    managed: &[(String, String)],
) -> Vec<(String, String)> {
    use std::collections::BTreeMap;
    fn slot(k: &str) -> String {
        #[cfg(windows)]
        {
            k.to_uppercase()
        }
        #[cfg(not(windows))]
        {
            k.to_string()
        }
    }
    // Value carries the ORIGINAL casing of the winning (last) layer.
    let mut merged: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (k, v) in scrubbed_base
        .iter()
        .chain(overrides)
        .chain(ordinary)
        .chain(managed)
    {
        merged.insert(slot(k), (k.clone(), v.clone()));
    }
    merged.into_values().collect()
}

/// A spawned child with its process-group id for [`kill_group`].
pub struct TrackedChild {
    child: std::process::Child,
    pid: u32,
}

impl TrackedChild {
    /// OS pid of the direct child (group leader on Unix).
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Reap after a kill (or a natural exit).
    pub fn wait(&mut self) -> Result<std::process::ExitStatus, RunError> {
        self.child.wait().map_err(|e| RunError::Io(e.to_string()))
    }
}

fn shell_for(command: &str) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        (
            "cmd".to_string(),
            vec!["/C".to_string(), command.to_string()],
        )
    }
    #[cfg(not(windows))]
    {
        (
            "sh".to_string(),
            vec!["-c".to_string(), command.to_string()],
        )
    }
}

/// Spawn without waiting: the group-kill test's entry point, and how the
/// shell layer launches anything it may need to stop.
pub fn spawn_command(
    command: &str,
    workdir: &Path,
    extra_env: &[(String, String)],
    managed_env: &[(String, String)],
) -> Result<TrackedChild, RunError> {
    let (shell, args) = shell_for(command);
    let mut cmd = std::process::Command::new(shell);
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        // Own process group: `kill -- -pid` reaches the whole tree.
        cmd.process_group(0);
    }
    let base: Vec<(String, String)> = std::env::vars().collect();
    // `extra_env` is scrubbed too (audit 11 FYI): it enters the ordinary
    // slot, and D29's claim is about the child's *whole* environment, not
    // just the inherited half. Managed stays host-trusted (D30).
    let env = build_env(
        &scrub_env_vars(&base),
        &[],
        &scrub_env_vars(extra_env),
        managed_env,
    );
    // Clear first: scrubbed-away names must not leak back through inheritance.
    cmd.args(&args)
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| RunError::Spawn(e.to_string()))?;
    let pid = child.id();
    // Drain pipes on background threads: a full pipe would wedge long-lived
    // grandchildren, and an unread pipe wedges the parent at wait.
    if let Some(mut out) = child.stdout.take() {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut out, &mut std::io::sink());
        });
    }
    if let Some(mut err) = child.stderr.take() {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut err, &mut std::io::sink());
        });
    }
    Ok(TrackedChild { child, pid })
}

/// Kill the whole group, then let the caller reap. Windows: `taskkill /T`
/// takes the tree. Unix: a direct group SIGKILL, verified by emptiness
/// after reaping our own leader (D131).
pub fn kill_group(pid: u32) -> Result<(), RunError> {
    #[cfg(windows)]
    {
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| RunError::Killed(e.to_string()))?;
        if status.success() {
            Ok(())
        } else {
            Err(RunError::Killed(format!("taskkill exited {status}")))
        }
    }
    #[cfg(not(windows))]
    {
        // D131: signal directly and verify by emptiness. `kill(1)`'s argv
        // parsing varies per image, and its probe lied in CI — a kill that
        // had worked read as failure. SIGKILL, not SIGTERM: the bash-runner
        // contract (D28/D30) admits no escalation window.
        // SAFETY: signal-only syscalls with an integer target; no pointers.
        if unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) } != 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ESRCH) {
                // Already gone: nothing to signal, no members to wait for.
                return Ok(());
            }
            return Err(RunError::Killed(format!("kill(-{pid}) failed: {err}")));
        }
        // Reap OUR leader before testing emptiness: our own un-reaped child
        // is a zombie, and `kill(-pgid, 0)` counts zombies as group members.
        // The callers' `child.wait()` runs only after this returns, so
        // without the in-loop reap the poll always saw a member, burned its
        // full budget on a kill that had worked, and reported failure for a
        // success (CI on the linux runner, 2026-10-13). WNOHANG: reap only
        // what has already exited, never block.
        for _ in 0..50 {
            let mut status: libc::c_int = 0;
            // SAFETY: waitpid on our own child only; `status` is a plain
            // out-parameter integer.
            unsafe {
                libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG);
            }
            if !group_has_members(pid) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err(RunError::Killed(format!(
            "process group {pid} still alive after KILL"
        )))
    }
}

/// True while any member of `pgid` (zombies included — which is precisely
/// why `kill_group` reaps its own leader before asking, D131) still exists.
/// Signal 0 on the negative pid asks the group, not one process.
#[cfg(not(windows))]
fn group_has_members(pgid: u32) -> bool {
    // D131: the kernel, not `kill(1)`. The binary's argv parsing varies per
    // image, and its rc=1 probe lied in CI for a group that still held our
    // own un-reaped leader — a working kill read as failure. Signal 0:
    // rc 0 = a member exists; EPERM = members exist and are not ours to
    // signal (still alive); ESRCH alone means the group is empty. Any
    // other failure reads as "members remain" — the safe direction,
    // because the bounded poll converts it into `Err` like survivors.
    // SAFETY: signal-only syscall with an integer target; no pointers, so
    // there is nothing to invalidate.
    if unsafe { libc::kill(-(pgid as libc::pid_t), 0) } == 0 {
        return true;
    }
    !matches!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    )
}

/// Keep at most `cap` bytes of `output`, never splitting a UTF-8 char.
///
/// The old inline version called `String::truncate(cap)` first, which
/// **panics** when `cap` lands mid-codepoint, under a held `Store` lock in
/// the tools layer (audit 10) — and its "safety net" loop tested
/// `kept.is_char_boundary(kept.len())`, which is always true after a
/// successful truncate, i.e. dead code.
pub fn truncate_kept(output: &str, cap: usize) -> String {
    // Slice at a char boundary ≤ cap: clamp to the string length first (a
    // cap above the output length is a no-op, not a panic), then walk DOWN
    // to the nearest boundary. Never `String::truncate(cap)` — it asserts
    // `is_char_boundary(cap)` and panics on the first multi-byte straddle.
    let mut end = cap.min(output.len());
    while end > 0 && !output.is_char_boundary(end) {
        end -= 1;
    }
    output[..end].to_string()
}

/// Run to completion in `workdir`, truncating with spill past `limits`.
pub fn run_command(
    command: &str,
    workdir: &Path,
    extra_env: &[(String, String)],
    managed_env: &[(String, String)],
    limits: RunLimits,
) -> Result<RunOutput, RunError> {
    let (shell, args) = shell_for(command);
    let mut cmd = std::process::Command::new(shell);
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let base: Vec<(String, String)> = std::env::vars().collect();
    // Same scrub on `extra_env` as `spawn_command` (D29 covers the whole
    // child environment; audit 11 FYI).
    let env = build_env(
        &scrub_env_vars(&base),
        &[],
        &scrub_env_vars(extra_env),
        managed_env,
    );
    cmd.args(&args)
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| RunError::Spawn(e.to_string()))?;
    let pid = child.id();
    // Drain pipes on background threads: a full pipe would wedge the child,
    // and an unread pipe wedges the parent at wait.
    let out_thread = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::copy(&mut pipe, &mut buf);
            buf
        })
    });
    let err_thread = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::copy(&mut pipe, &mut buf);
            buf
        })
    });
    // Wall-clock watchdog (audit 10): poll instead of blocking forever on
    // `output()`; at the deadline kill the whole GROUP — `taskkill /T` /
    // `kill -- -pgid` — because killing only `cmd` would orphan grandchildren
    // and the next run would still be wedged behind them.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(limits.timeout_ms);
    let status = loop {
        match child.try_wait().map_err(|e| RunError::Io(e.to_string()))? {
            Some(st) => break st,
            None if std::time::Instant::now() >= deadline => {
                let _ = kill_group(pid);
                let _ = child.wait();
                // The pipe threads exit on their own once the kill closes
                // the child's ends; joining here would only add latency.
                return Err(RunError::Killed(format!(
                    "wall-clock timeout of {} ms exceeded",
                    limits.timeout_ms
                )));
            }
            None => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    };
    let stdout = String::from_utf8_lossy(
        &out_thread
            .map(|t| t.join().unwrap_or_default())
            .unwrap_or_default(),
    )
    .into_owned();
    let stderr = String::from_utf8_lossy(
        &err_thread
            .map(|t| t.join().unwrap_or_default())
            .unwrap_or_default(),
    )
    .into_owned();
    let total = stdout.len() + stderr.len();
    if total <= limits.max_bytes {
        return Ok(RunOutput {
            exit_code: status.code().unwrap_or(-1),
            stdout,
            stderr,
            truncated: false,
            spill_path: None,
        });
    }
    let kept = truncate_kept(&stdout, limits.max_bytes);
    let spill_path = workdir.join(format!(
        ".run-spill-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&spill_path, format!("{stdout}{stderr}"))
        .map_err(|e| RunError::Io(format!("spill failed: {e}")))?;
    Ok(RunOutput {
        exit_code: status.code().unwrap_or(-1),
        stdout: kept,
        stderr: String::new(),
        truncated: true,
        spill_path: Some(spill_path),
    })
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::group_has_members;
    use std::os::unix::process::CommandExt;

    /// A live group must report members (D131, red-first 2026-10-13): the
    /// external `kill(1)` probe returned rc=1 on a group that plainly held a
    /// running leader — the same lie that made `kill_group` burn its whole
    /// poll and report failure for a kill that had worked (the two CI
    /// failures on the linux runner).
    #[test]
    fn group_has_members_is_true_for_a_live_group() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("spawn sleep as its own group leader");
        let pgid = child.id();
        let members = group_has_members(pgid);
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            members,
            "a group holding a running leader must report members"
        );
    }
}
