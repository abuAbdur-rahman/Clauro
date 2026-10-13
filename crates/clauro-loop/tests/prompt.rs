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
    let a = build_system_prompt(&PromptInputs {
        tools: &defs,
        memory_instructions: None,
    });
    let b = build_system_prompt(&PromptInputs {
        tools: &defs,
        memory_instructions: None,
    });
    assert_eq!(
        frozen_hash(&a, &defs),
        frozen_hash(&b, &defs),
        "same surface, same hash, every turn"
    );
    // The property that matters across turns is stability beyond THIS
    // process: a literal pin, so a hasher or field-encoding change breaks
    // here instead of invalidating every stored `system_frozen` (review 21).
    // This surface is the no-memory prompt; the wording snapshot pins the
    // memory-instructions variant.
    assert_eq!(
        frozen_hash(&a, &defs),
        "113ec8cd58c6fc8f",
        "the frozen hash is repeatable across process restarts"
    );
}

#[test]
fn hash_changes_when_tool_list_changes() {
    let all: Vec<_> = clauro_tools::eight_definitions();
    let fewer: Vec<_> = all.iter().take(7).cloned().collect();
    let ha = frozen_hash("sys", &all);
    let hb = frozen_hash("sys", &fewer);
    assert_ne!(
        ha, hb,
        "which is why enabling bash opens a fresh thread (D19, D67)"
    );
}

fn tool(name: &str, description: &str, schema: serde_json::Value) -> clauro_tools::ToolDefinition {
    clauro_tools::ToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        input_schema: schema,
        writes_to_disk: false,
    }
}

/// D76: effort, `max_tokens` and `tool_choice` are not parameters of the hash —
/// there is nowhere for them to enter. The inputs that DO belong to the
/// surface are prompt text and the serialized tools, so this test varies one
/// of those: same names, same descriptions, different schema → different
/// hash. A schema-only change moves what the request carries, so it must
/// move the frozen hash (review 21, D19).
#[test]
fn hash_covers_the_serialized_tool_schema() {
    let defs = clauro_tools::eight_definitions();
    let mut changed = defs.clone();
    changed[0].input_schema =
        serde_json::json!({"type": "object", "properties": {"surprise": {"type": "string"}}});
    let prompt = build_system_prompt(&PromptInputs {
        tools: &defs,
        memory_instructions: None,
    });
    let h1 = frozen_hash(&prompt, &defs);
    let h2 = frozen_hash(&prompt, &changed);
    assert_ne!(h1, h2, "a schema-only change must move the hash (D19)");
    assert_eq!(h1.len(), 16, "64-bit hex");
}

/// A flat name concatenation lets `["ab"]` hash equal to `["a","b"]`; unit
/// separators between tools and fields make the surface unambiguous
/// (review 21).
#[test]
fn hash_cannot_confuse_a_tool_name_boundary() {
    let joined = tool("ab", "same", serde_json::json!({}));
    let split_a = tool("a", "same", serde_json::json!({}));
    let split_b = tool("b", "same", serde_json::json!({}));
    assert_ne!(
        frozen_hash("sys", &[joined]),
        frozen_hash("sys", &[split_a, split_b]),
        "tool boundaries must be unambiguous"
    );
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
    let defs = clauro_tools::eight_definitions();
    assert_eq!(
        frozen_hash(text, &defs),
        // Pin moved 2026-10-05 by `Tasks/014`: the Artifacts paragraph (D4, D5,
        // D110) joined the prompt. D39 re-read before moving it — the wording
        // is ours, describing our own frame's limits, and borrows nothing from
        // any first-party material.
        //
        // Pin moved 2026-10-12 by the review-21 D19 fix: `frozen_hash` now
        // covers each tool's serialized schema, not just its name. The
        // wording itself did not move (the prompt builder is untouched).
        "0cf7e8238873c898",
        "prompt wording moved — re-read for D39, then update the pin"
    );
}

#[test]
fn first_turn_setup_returns_prompt_and_hash_together() {
    let defs = clauro_tools::eight_definitions();
    let (prompt, hash) = first_turn_setup(&defs, None);
    assert_eq!(hash, frozen_hash(&prompt, &defs));
    assert!(prompt.contains("/memories"));
}
