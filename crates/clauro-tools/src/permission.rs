//! Permission resolution: two pure stages (`CONTRACTS.md` §3).
//!
//! Stage 1 folds per effect (PORTED from OpenCode's `findLast`: the LAST rule
//! matching a tool *within its own effect class* wins). Stage 2 applies
//! precedence across the three folded values (CLAURO-ORIGINAL): fail-closed,
//! so a matching error can only ever make the outcome stricter —
//! deny > ask > allow. Both stages pure and total.

use clauro_core::{Effect, PermissionRule, DEFAULT_EFFECT};

/// Resolve the effective permission for `tool` under `rules`.
#[must_use]
pub fn resolve(tool: &str, rules: &[PermissionRule]) -> Effect {
    let mut deny = None;
    let mut ask = None;
    let mut allow = None;
    for rule in rules.iter().filter(|r| r.tool == tool) {
        match rule.effect {
            Effect::Deny => deny = Some(()),
            Effect::Ask => ask = Some(()),
            Effect::Allow => allow = Some(()),
        }
    }
    if deny.is_some() {
        Effect::Deny
    } else if ask.is_some() {
        Effect::Ask
    } else if allow.is_some() {
        Effect::Allow
    } else {
        DEFAULT_EFFECT
    }
}
