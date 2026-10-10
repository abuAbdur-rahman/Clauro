//! The OpenAI request translator — D48's second adapter, request side.
//!
//! `build_normal_request` speaks Anthropic: `system` on top, `thinking` with
//! block-binding, `context_management` edits, tools with `input_schema`, and
//! an `anthropic-beta` header riding alongside. None of that survives contact
//! with a `chat/completions` endpoint — the unknown fields are a 400, and
//! translating a thinking budget into `reasoning_effort` would be a
//! plausible-looking wrong turn. So the rule here is **drop, never approximate**:
//!
//! - `system` → the first `system` message (the top-level field has no
//!   counterpart in the chat shape).
//! - `thinking` / `context_management` / beta headers → gone. Thinking
//!   blocks *inside* messages go too: this wire has no signature to replay.
//! - `tools[].input_schema` → `function.parameters`; `tool_choice` object →
//!   the bare string form.
//! - assistant `tool_use` → `tool_calls`, `input` stringified into
//!   `function.arguments` (the chat wire wants a JSON **string**).
//! - user `tool_result` blocks → standalone `role: "tool"` messages placed
//!   directly after the message that made the calls — the position the chat
//!   API requires, and the reason `assemble_messages` splits results out of
//!   the assistant message.
//!
//! Everything the two wires share (`model`, `max_tokens`, message order)
//! passes through unchanged. `stream` is a transport concern, set by the
//! sender (the same place Anthropic's is set).

use serde_json::{json, Value};

/// Rewrite an Anthropic-shaped request body as a `chat/completions` body.
///
/// Takes the body `build_normal_request` produced (or an equivalent,
/// including compaction bodies — `compaction` rides the same rewrite).
#[must_use]
pub fn translate_request(body: &Value) -> Value {
    let mut out = json!({
        "model": body.get("model").cloned().unwrap_or(Value::Null),
        "max_tokens": body.get("max_tokens").cloned().unwrap_or(Value::Null),
    });

    let mut messages: Vec<Value> = Vec::new();

    // `system` (string or block array) → first system message.
    match body.get("system") {
        Some(Value::String(s)) if !s.is_empty() => {
            messages.push(json!({"role": "system", "content": s}));
        }
        Some(Value::Array(blocks)) => {
            let text = blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                messages.push(json!({"role": "system", "content": text}));
            }
        }
        _ => {}
    }

    if let Some(Value::Array(input)) = body.get("messages") {
        for message in input {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            let blocks = match message.get("content") {
                Some(Value::Array(blocks)) => blocks.clone(),
                // String content passes straight through.
                Some(other) => {
                    messages.push(json!({"role": role, "content": other.clone()}));
                    continue;
                }
                None => continue,
            };

            match role {
                "assistant" => {
                    let mut text: Vec<String> = Vec::new();
                    let mut calls: Vec<Value> = Vec::new();
                    for block in &blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(t) = block.get("text").and_then(Value::as_str) {
                                    if !t.is_empty() {
                                        text.push(t.to_string());
                                    }
                                }
                            }
                            Some("tool_use") => {
                                let name = block
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                let args = block.get("input").cloned().unwrap_or_else(|| json!({}));
                                calls.push(json!({
                                    "id": block.get("id").cloned().unwrap_or(Value::Null),
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "arguments": Value::String(args.to_string()),
                                    },
                                }));
                            }
                            // thinking / redacted_thinking: no signature to
                            // replay on this wire — dropped, never faked.
                            _ => {}
                        }
                    }
                    let mut msg = json!({"role": "assistant"});
                    if text.is_empty() {
                        // `content` may be omitted or null beside tool_calls;
                        // null is the shape every chat server accepts.
                        msg["content"] = Value::Null;
                    } else {
                        msg["content"] = Value::String(text.join("\n"));
                    }
                    if !calls.is_empty() {
                        msg["tool_calls"] = Value::Array(calls);
                    }
                    messages.push(msg);
                }
                "user" => {
                    // tool_result blocks become standalone `tool` messages,
                    // in block order, directly after the calls they answer.
                    let mut texts: Vec<String> = Vec::new();
                    for block in &blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("tool_result") => {
                                let content = match block.get("content") {
                                    Some(Value::String(s)) => s.clone(),
                                    Some(Value::Array(parts)) => parts
                                        .iter()
                                        .filter_map(|p| p.get("text").and_then(Value::as_str))
                                        .collect::<Vec<_>>()
                                        .join("\n"),
                                    _ => String::new(),
                                };
                                messages.push(json!({
                                    "role": "tool",
                                    "tool_call_id": block.get("tool_use_id").cloned().unwrap_or(Value::Null),
                                    "content": content,
                                }));
                            }
                            Some("text") => {
                                if let Some(t) = block.get("text").and_then(Value::as_str) {
                                    if !t.is_empty() {
                                        texts.push(t.to_string());
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    if !texts.is_empty() {
                        messages.push(json!({"role": "user", "content": texts.join("\n")}));
                    }
                }
                "system" => messages.push(json!({"role": "system", "content": blocks})),
                other => {
                    // Unknown role: keep it rather than lose history — an
                    // unexpected role is the endpoint's 400 to explain.
                    messages.push(json!({"role": other, "content": blocks}));
                }
            }
        }
    }
    out["messages"] = Value::Array(messages);

    // tools[]: input_schema → function.parameters.
    if let Some(Value::Array(tools)) = body.get("tools") {
        let mapped: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.get("name").cloned().unwrap_or(Value::Null),
                        "description": t.get("description").cloned().unwrap_or(Value::Null),
                        "parameters": t.get("input_schema")
                            .or_else(|| t.get("parameters"))
                            .cloned()
                            .unwrap_or_else(|| json!({"type": "object"})),
                    }
                })
            })
            .collect();
        if !mapped.is_empty() {
            out["tools"] = Value::Array(mapped);
        }
    }

    // tool_choice: {"type":"auto"} → "auto"; {"type":"tool","name":x} →
    // the function form; anything else passes through untouched.
    if let Some(choice) = body.get("tool_choice") {
        match choice.get("type").and_then(Value::as_str) {
            Some("auto") => out["tool_choice"] = json!("auto"),
            Some("none") => out["tool_choice"] = json!("none"),
            Some("any") => out["tool_choice"] = json!("required"),
            Some("tool") => {
                out["tool_choice"] = json!({
                    "type": "function",
                    "function": {"name": choice.get("name").cloned().unwrap_or(Value::Null)},
                });
            }
            _ => out["tool_choice"] = choice.clone(),
        }
    }

    out
}
