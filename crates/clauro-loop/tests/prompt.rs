//! Task 023 — prompt assembly and the frozen hash (RED).
//!
//! Assembled once at the thread's first turn, hashed into
//! `thread.system_frozen`, never rebuilt (D19). Effort, `max_tokens` and
//! `tool_choice` vary without changing the hash: they are request parameters,
//! never prompt text (D76). Wording is ours throughout (D39).

use clauro_loop::prompt::{build_system_prompt, first_turn_setup, frozen_hash, PromptInputs};

#[test]
fn hash_stable_across_turns_for_same_surface() {
    let defs = clauro_tools::eight_definitions();
    let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
    let a = build_system_prompt(&PromptInputs {
        tools: &defs,
        memory_instructions: None,
    });
    let b = build_system_prompt(&PromptInputs {
        tools: &defs,
        memory_instructions: None,
    });
    assert_eq!(
        frozen_hash(&a, &names),
        frozen_hash(&b, &names),
        "same surface, same hash, every turn"
    );
}

#[test]
fn hash_changes_when_tool_list_changes() {
    let all: Vec<_> = clauro_tools::eight_definitions();
    let fewer: Vec<_> = all.iter().take(7).cloned().collect();
    let ha = frozen_hash(
        "sys",
        &all.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
    );
    let hb = frozen_hash(
        "sys",
        &fewer.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
    );
    assert_ne!(
        ha, hb,
        "which is why enabling bash opens a fresh thread (D19, D67)"
    );
}

#[test]
fn effort_and_params_cannot_move_the_hash() {
    // The hash function takes prompt text + tool names. Budgets, effort,
    // max_tokens and tool_choice have no parameter to enter through (D76).
    let h1 = frozen_hash("sys", &["fs"]);
    let h2 = frozen_hash("sys", &["fs"]);
    assert_eq!(h1, h2);
    assert_eq!(h1.len(), 16, "64-bit hex");
}

#[test]
fn prompt_carries_inventory_preconditions_bounding_and_memories() {
    let defs = clauro_tools::eight_definitions();
    let text = build_system_prompt(&PromptInputs {
        tools: &defs,
        memory_instructions: None,
    });
    for marker in [
        "fs",
        "bash",
        "question",
        "read",
        "workspace",
        "preview",
        "/memories",
    ] {
        assert!(text.contains(marker), "prompt must say {marker}: {text}");
    }
}

/// A7: the artifact contract is in the prompt, or the model writes artifacts
/// that cannot work. Every clause here is one this repo has decided, and each
/// has a D-number; none of them are advice, they are the frame's limits.
#[test]
fn prompt_states_the_artifact_contract() {
    let defs = clauro_tools::eight_definitions();
    let text = build_system_prompt(&PromptInputs {
        tools: &defs,
        memory_instructions: None,
    });
    for marker in [
        // D5: predefined utility classes only.
        "predefined",
        // D4: storage is unavailable, and it is the usual blank-artifact cause.
        "localStorage",
        "indexedDB",
        // D3: no network, so nothing may be fetched or linked.
        "no network",
        // D110: the JSX pragma is ours and it is a DOM builder.
        "h(",
        // The compiled-shape contract, so a static artifact needs no script.
        "script type=\"text/jsx\"",
        // The size the frame will accept.
        "1 MB",
    ] {
        assert!(text.contains(marker), "prompt must say {marker}: {text}");
    }
}

#[test]
fn prompt_snapshot_pins_our_wording() {
    // Any wording change fails here first, forcing a conscious D39 re-check.
    let defs = clauro_tools::eight_definitions();
    let text = build_system_prompt(&PromptInputs {
        tools: &defs,
        memory_instructions: Some("Be kind."),
    });
    assert!(text.contains("Be kind."));
    assert!(
        text.len() > 500 && text.len() < 6000,
        "unexpected size: {}",
        text.len()
    );
    insta_like_snapshot(&text);
}

fn insta_like_snapshot(text: &str) {
    // Hand-rolled snapshot: the prompt hash is the pin. If this fails, the
    // wording moved — update the hash below deliberately, after a D39 read.
    assert_eq!(
        frozen_hash(
            text,
            &[
                "memory",
                "artifact",
                "web-search",
                "web-fetch",
                "fs",
                "compact",
                "bash",
                "question"
            ]
        ),
        // Pin moved 2026-10-05 by `Tasks/014`: the Artifacts paragraph (D4, D5,
        // D110) joined the prompt. D39 re-read before moving it — the wording
        // is ours, describing our own frame's limits, and borrows nothing from
        // any first-party material.
        "ccbcfa44e3478a93",
        "prompt wording moved — re-read for D39, then update the pin"
    );
}

#[test]
fn first_turn_setup_returns_prompt_and_hash_together() {
    let defs = clauro_tools::eight_definitions();
    let (prompt, hash) = first_turn_setup(&defs, None);
    assert_eq!(
        hash,
        frozen_hash(
            &prompt,
            &defs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>()
        )
    );
    assert!(prompt.contains("/memories"));
}
