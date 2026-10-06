//! The `bash` tool: off by default, approved every time (D28, D66, D67).
//!
//! This tool changes the security claim from "never executes code on your
//! machine" — deliberate, recorded in `MISSION.md` §5. Three consent layers,
//! none remembered: per-project opt-in, per-invocation approval through the
//! loop's `ApprovalQueue`, and no persisted rule anywhere. A rejected command
//! is a `rejected` result (D66, `CONTRACTS.md` §3); a non-zero exit is `ok`
//! with output attached (D55). The model tool exposes no `stdin` and no
//! `env` (D29); managed env always wins (D30). Root-confined to the session
//! workspace via the runner cwd — scrubbed, killed, confined, not contained.

use crate::registry::Registry;
use clauro_core::{Effect, PermissionRule, ToolContext, ToolOutcome};
use clauro_fs::runner::{run_command, RunLimits, RUN_DEFAULT_MAX_BYTES};
use serde_json::Value;
use std::sync::Arc;

/// The always-ask rule for `bash`. Computed per turn, never stored anywhere:
/// no trust-on-first-use, no allowlist, no remembered prefix (D66).
#[must_use]
pub fn bash_ask_rule() -> PermissionRule {
    PermissionRule {
        effect: Effect::Ask,
        tool: "bash".to_string(),
    }
}

/// Granted set for a project: `bash` joins iff the project opted in
/// (`project.bash_enabled`, D67). Anthropic gains it in place via
/// `tool_addition` (D94); the OpenAI-compatible adapter freezes without it.
#[must_use]
pub fn granted_with_bash(base: &[&str], bash_enabled: bool) -> Vec<String> {
    let mut out: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    if bash_enabled && !out.iter().any(|t| t == "bash") {
        out.push("bash".to_string());
    }
    out
}

/// Bind the `bash` handler onto a session-scoped host. `workspace` is the
/// session root the runner confines the child to.
pub fn register_bash(reg: &mut Registry, host: Arc<crate::FsHost>) {
    let _ = reg.set_handler("bash", move |input: &Value, ctx: &ToolContext| {
        host.bash_run(input, ctx)
    });
}

impl crate::FsHost {
    /// Execute one approved command. Approval itself lives in the loop
    /// (`ApprovalQueue`); by the time this runs, the user has said yes.
    pub fn bash_run(&self, input: &Value, _ctx: &ToolContext) -> ToolOutcome {
        let command = input.get("command").and_then(Value::as_str).unwrap_or("");
        if command.trim().is_empty() {
            return ToolOutcome::Error {
                message: "bash needs a command".to_string(),
            };
        }
        match run_command(
            command,
            self.session_root(),
            &[],
            &[],
            RunLimits {
                max_bytes: RUN_DEFAULT_MAX_BYTES,
            },
        ) {
            Ok(out) => {
                let mut preview = format!("exit code: {}\n{}", out.exit_code, out.stdout);
                if out.truncated {
                    preview.push_str(&format!(
                        "\n[truncated, full output at {}]",
                        out.spill_path
                            .as_ref()
                            .map(|p| p.display().to_string())
                            .unwrap_or_default()
                    ));
                }
                if !out.stderr.is_empty() {
                    preview.push_str(&format!("\nstderr:\n{}", out.stderr));
                }
                ToolOutcome::Ok {
                    preview,
                    preview_path: None,
                    // The spilled full output re-reads through `fs read`.
                    full_path: out.spill_path.map(|p| p.display().to_string()),
                }
            }
            Err(e) => ToolOutcome::Error {
                message: e.to_string(),
            },
        }
    }
}
