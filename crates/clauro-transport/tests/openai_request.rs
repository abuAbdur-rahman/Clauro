//! Task 005 addendum — the OpenAI request translator, request side (RED).
//!
//! D48 ships two adapters: Anthropic, and one OpenAI-compatible adapter for
//! everything else. The response side (`openai_compat.rs`) normalises
//! third-party chunks into the shared union; this is the other half — the
//! Anthropic-shaped body `build_normal_request` produces, rewritten as a
//! `chat/completions` body the second adapter can actually POST.
//!
//! The mapping is deliberately lossy in exactly one direction: Anthropic-only
//! controls (`thinking`, `context_management`, the `anthropic-beta` header)
//! are **dropped**, not approximated — sending them at a chat-completions
//! endpoint is a 400, and faking a budget as `reasoning_effort` would be a
//! plausible-looking wrong turn (D48's degrade-visibly rule, applied to the
//! request path: the model list and stream still work; thinking simply is
//! not promised on this wire).

use clauro_transport::openai_request::translate_request;
use serde_json::{json, Value};

/// A body exactly as `build_normal_request` builds it: system on top,
/// thinking with block-binding, context-management edits, beta header
/// separate, tools with `input_schema`, `tool_choice` as an object.
fn anthropic_shaped() -> serde_json::Value {
    json!({
        "model": "gemma-4-26b",
        "max_tokens": 4096,
        "system": "You are terse.",
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "list a file"}]},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "hmm", "signature": "sig-1"},
                {"type": "text", "text": "checking"},
                {"type": "tool_use", "id": "call-a", "name": "fs", "input": {"p": "a.txt"}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call-a", "content": "file!"}
            ]}
        ],
        "tools": [
            {"name": "fs", "description": "read a file", "input_schema": {"type": "object", "properties": {"p": {"type": "string"}}}}
        ],
        "tool_choice": {"type": "auto"},
        "thinking": {"type": "enabled", "budget_tokens": 8000, "block_binding": {"prefix_mismatch_behavior": "drop_block"}},
        "context_management": {"edits": [{"type": "clear_thinking_20251015"}]}
    })
}

#[test]
fn system_becomes_the_first_system_message() {
    let out = translate_request(&anthropic_shaped());
    let messages = out["messages"].as_array().expect("messages array");
    assert_eq!(
        messages[0]["role"], "system",
        "system rides a message, not a top-level field: {messages:?}"
    );
    assert_eq!(messages[0]["content"], "You are terse.");
    assert!(
        out.get("system").is_none(),
        "top-level system is Anthropic-only: {out:?}"
    );
}

#[test]
fn anthropic_only_controls_are_dropped_not_approximated() {
    let out = translate_request(&anthropic_shaped());
    for forbidden in ["thinking", "context_management", "anthropic-beta"] {
        assert!(
            out.get(forbidden).is_none(),
            "{forbidden} would 400 on chat/completions: {out:?}"
        );
    }
    assert_eq!(out["model"], "gemma-4-26b");
    assert_eq!(out["max_tokens"], 4096, "max_tokens carries across");
}

#[test]
fn tools_and_tool_choice_take_the_openai_shape() {
    let out = translate_request(&anthropic_shaped());
    let tools = out["tools"].as_array().expect("tools array");
    assert_eq!(tools[0]["type"], "function");
    assert_eq!(tools[0]["function"]["name"], "fs");
    assert_eq!(tools[0]["function"]["description"], "read a file");
    assert_eq!(
        tools[0]["function"]["parameters"]["type"], "object",
        "input_schema maps to parameters: {tools:?}"
    );
    assert!(
        tools[0]["function"].get("input_schema").is_none(),
        "input_schema is Anthropic naming: {tools:?}"
    );
    assert_eq!(
        out["tool_choice"], "auto",
        "auto is a bare string on this wire: {out:?}"
    );
}

#[test]
fn tool_use_becomes_tool_calls_with_stringified_arguments() {
    let out = translate_request(&anthropic_shaped());
    let messages = out["messages"].as_array().expect("messages array");
    let assistant = messages
        .iter()
        .find(|m| m["role"] == "assistant")
        .expect("assistant message");
    let calls = assistant["tool_calls"].as_array().expect("tool_calls");
    assert_eq!(calls[0]["id"], "call-a");
    assert_eq!(calls[0]["type"], "function");
    assert_eq!(calls[0]["function"]["name"], "fs");
    assert_eq!(
        calls[0]["function"]["arguments"], "{\"p\":\"a.txt\"}",
        "arguments are a JSON *string* on this wire: {calls:?}"
    );
    assert!(
        assistant
            .get("content")
            .is_none_or(|c| c.is_null() || c == "checking"),
        "text before the call survives as content: {assistant:?}"
    );
}

#[test]
fn thinking_blocks_never_reach_the_wire() {
    let out = translate_request(&anthropic_shaped());
    let messages = out["messages"].as_array().expect("messages array");
    let assistant = messages
        .iter()
        .find(|m| m["role"] == "assistant")
        .expect("assistant message");
    // Content is either a joined string or an array of parts; neither may
    // carry a thinking block or the signature that only Anthropic verifies.
    if let Some(Value::Array(blocks)) = assistant.get("content") {
        assert!(
            blocks.iter().all(|b| b["type"] != "thinking"),
            "no signature concept exists here to replay: {blocks:?}"
        );
    }
    let raw = out.to_string();
    assert!(
        !raw.contains("sig-1") && !raw.contains("\"thinking\""),
        "thinking text and signature never reach the wire: {raw}"
    );
}

#[test]
fn tool_results_become_role_tool_messages_right_after_the_call() {
    let out = translate_request(&anthropic_shaped());
    let messages = out["messages"].as_array().expect("messages array");
    let tool_at = messages
        .iter()
        .position(|m| m["role"] == "assistant" && m.get("tool_calls").is_some())
        .expect("assistant tool_calls message");
    let tool_msg = messages
        .get(tool_at + 1)
        .expect("a message follows the tool_calls");
    assert_eq!(
        tool_msg["role"], "tool",
        "results answer directly after the call: {messages:?}"
    );
    assert_eq!(tool_msg["tool_call_id"], "call-a");
    assert_eq!(tool_msg["content"], "file!");
    assert!(
        !messages.iter().any(|m| m["role"] == "user"
            && m["content"]
                .as_array()
                .map(|b| b.iter().any(|x| x["type"] == "tool_result"))
                .unwrap_or(false)),
        "no Anthropic-shaped tool_result survives: {messages:?}"
    );
}

#[test]
fn plain_user_text_stays_a_user_message() {
    let out = translate_request(&anthropic_shaped());
    let messages = out["messages"].as_array().expect("messages array");
    assert_eq!(messages[1]["role"], "user");
    assert_eq!(messages[1]["content"], "list a file");
}
