//! Task 007 — permission resolution is two pure stages (RED).
//!
//! Stage 1 folds per effect (PORTED: OpenCode `findLast`, last matching rule
//! of each effect wins). Stage 2 applies fail-closed precedence across the
//! folded values (ORIGINAL: deny > ask > allow). Both stages pure and total.
//! Examples mirror `CONTRACTS.md` §3.

use clauro_core::{Effect, PermissionRule, DEFAULT_EFFECT};

fn rule(effect: Effect, tool: &str) -> PermissionRule {
    PermissionRule {
        effect,
        tool: tool.to_string(),
    }
}

use clauro_tools::resolve;

#[test]
fn deny_wins_over_allow_regardless_of_order() {
    assert_eq!(
        resolve("fs", &[rule(Effect::Ask, "fs"), rule(Effect::Deny, "fs")]),
        Effect::Deny
    );
    assert_eq!(
        resolve("fs", &[rule(Effect::Deny, "fs"), rule(Effect::Ask, "fs")]),
        Effect::Deny,
        "order irrelevant across effects"
    );
    assert_eq!(
        resolve(
            "bash",
            &[rule(Effect::Allow, "bash"), rule(Effect::Deny, "bash")]
        ),
        Effect::Deny,
        "fail-closed: a matching error can only make it stricter"
    );
}

#[test]
fn allow_plus_ask_yields_ask() {
    assert_eq!(
        resolve("fs", &[rule(Effect::Allow, "fs"), rule(Effect::Ask, "fs")]),
        Effect::Ask
    );
}

#[test]
fn most_recent_rule_wins_within_an_effect() {
    // Stage 1: last matching rule of the SAME effect wins; stage 2 still
    // fail-closed across effects. Two allows: last allow wins (still allow).
    assert_eq!(
        resolve(
            "fs",
            &[rule(Effect::Allow, "fs"), rule(Effect::Allow, "fs")]
        ),
        Effect::Allow
    );
}

#[test]
fn no_match_falls_back_to_default_allow() {
    assert_eq!(resolve("fs", &[rule(Effect::Deny, "bash")]), DEFAULT_EFFECT);
    assert_eq!(resolve("fs", &[]), DEFAULT_EFFECT);
    assert_eq!(DEFAULT_EFFECT, Effect::Allow);
}

#[test]
fn rules_for_other_tools_do_not_leak() {
    assert_eq!(
        resolve(
            "memory",
            &[rule(Effect::Deny, "bash"), rule(Effect::Ask, "fs")]
        ),
        Effect::Allow
    );
}
