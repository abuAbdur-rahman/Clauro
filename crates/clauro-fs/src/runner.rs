//! Host-owned command runner (D28–D30, task 012).
//!
//! One runner, no new dependencies: process-group kill is `taskkill /T /F`
//! on Windows and a `process_group` + `kill -- -pgid` on Unix (both present
//! on dev and CI images). Output truncates with spill to disk, fd0 is
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
}

/// Variable names that never reach the child, matched case-insensitively on
/// substring: keys, secrets, tokens, passwords, credentials, private matter.
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
    for prefix in [
        "sk-",
        "ghp_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xoxr-",
        "xoxs-",
        "AKIA",
    ] {
        if v.contains(prefix) {
            return true;
        }
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

/// Fixed merge order (D30): scrubbed process env → internal overrides →
/// ordinary env → managed. Managed always wins; a model-supplied entry can
/// never displace it.
pub fn build_env(
    scrubbed_base: &[(String, String)],
    overrides: &[(String, String)],
    ordinary: &[(String, String)],
    managed: &[(String, String)],
) -> Vec<(String, String)> {
    use std::collections::BTreeMap;
    let mut merged = BTreeMap::new();
    for (k, v) in scrubbed_base
        .iter()
        .chain(overrides)
        .chain(ordinary)
        .chain(managed)
    {
        merged.insert(k.clone(), v.clone());
    }
    merged.into_iter().collect()
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
    let env = build_env(&scrub_env_vars(&base), &[], extra_env, managed_env);
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
/// takes the tree. Unix: negative-pid `kill` takes the process group the
/// child leads.
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
        let status = std::process::Command::new("kill")
            .args(["-KILL".to_string(), format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| RunError::Killed(e.to_string()))?;
        if status.success() {
            Ok(())
        } else {
            Err(RunError::Killed(format!("kill exited {status}")))
        }
    }
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
    let env = build_env(&scrub_env_vars(&base), &[], extra_env, managed_env);
    cmd.args(&args)
        .current_dir(workdir)
        .stdin(Stdio::null())
        .env_clear();
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let output = cmd.output().map_err(|e| RunError::Spawn(e.to_string()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let total = stdout.len() + stderr.len();
    if total <= limits.max_bytes {
        return Ok(RunOutput {
            exit_code: output.status.code().unwrap_or(-1),
            stdout,
            stderr,
            truncated: false,
            spill_path: None,
        });
    }
    let mut kept = stdout.clone();
    kept.truncate(limits.max_bytes);
    while !kept.is_char_boundary(kept.len()) {
        kept.pop();
    }
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
        exit_code: output.status.code().unwrap_or(-1),
        stdout: kept,
        stderr: String::new(),
        truncated: true,
        spill_path: Some(spill_path),
    })
}
